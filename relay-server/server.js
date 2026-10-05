/**
 * GroceryApp Relay Server — v2 with Identity + Rate Limiting
 *
 * Enhanced relay server with:
 *  - Device enrollment endpoint (POST /enroll)
 *  - Family invite signature verification
 *  - Rate limiting per device token (max 100 messages/min)
 *  - WebSocket authentication via relayToken
 *  - Configurable ports via environment variables
 *
 * Design:
 *  - REST endpoints: /health, /enroll, /stats
 *  - WebSocket endpoint: /ws with relayToken auth
 *  - Rate limiting uses in-memory counters with 1-minute windows
 *  - Invite verification validates Ed25519 signatures
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Blind RSA Token Issuer ──────────────────────────────────────────────────

const { UsedTokensStore } = require('./tokens/used-tokens-store');
const { collectBody } = require('./lib/collect-body');
const { handlePricesRequest, cleanPricesState } = require('./prices/prices-server');

// ─── Dedicated State Directory ──────────────────────────────────────────────
// When RELAY_DATA_DIR is set, ALL persisted relay state (relay-state.json,
// used-tokens.json, data/) lives under it instead of /app. This lets a Docker
// volume be mounted at that directory WITHOUT shadowing the application code
// (mounting a volume over /app would hide server.js and the container would
// stop booting). See docker-compose.yml: RELAY_DATA_DIR=/data + relay-data
// volume.
const RELAY_DATA_DIR = process.env.RELAY_DATA_DIR || null;
if (RELAY_DATA_DIR) {
  try {
    fs.mkdirSync(RELAY_DATA_DIR, { recursive: true });
  } catch (err) {
    console.error(`[state] Cannot create RELAY_DATA_DIR "${RELAY_DATA_DIR}": ${err.message}`);
  }
}

/**
 * Lazy-loaded BlindRSA suite instance and issuer private key.
 * Loaded asynchronously on first request to /relay/request-token.
 */
let _blindRsaSuite = null;
let _issuerPrivateKey = null;

const ISSUER_PRIVATE_KEY_PATH =
  process.env.ISSUER_PRIVATE_KEY_PATH || path.join(__dirname, 'keys', 'issuer-private-key.pem');
const ISSUER_PRIVATE_KEY_PEM = process.env.ISSUER_PRIVATE_KEY || null;

/** Per-device token rate limit: N tokens per hour */
const TOKEN_RATE_LIMIT = parseInt(process.env.TOKEN_RATE_LIMIT || '10', 10);
const TOKEN_RATE_WINDOW_MS = 3_600_000; // 1 hour

/**
 * Per-enrollment token issuance rate limiters.
 * Map<relayToken, { count: number, windowStart: number }>
 *
 * NOTE: In-memory only — resets on restart. This is intentional:
 * - The used-tokens store (checkAndMark) prevents replay of issued tokens.
 * - Restart is a deliberate admin action.
 * - Persistence would add complexity for marginal security gain.
 * See UsedTokensStore for the persisted counterpart.
 */
const tokenRateLimiters = new Map();

/**
 * Used tokens store for single-use enforcement at the pool level.
 * Shared with pool-server via handlePoolRequest pass-through.
 */
const usedTokensStore = new UsedTokensStore(
  RELAY_DATA_DIR ? { storeFile: path.join(RELAY_DATA_DIR, 'used-tokens.json') } : {}
);

/**
 * Parse a PEM-encoded key to DER bytes (ArrayBuffer).
 * Strips header/footer lines and base64-decodes.
 * @param {string} pem
 * @returns {ArrayBuffer}
 */
function pemToDer(pem) {
  const base64 = pem
    .replace(/-----BEGIN [\w ]+-----/g, '')
    .replace(/-----END [\w ]+-----/g, '')
    .replace(/\s/g, '');
  const binary = Buffer.from(base64, 'base64');
  const bytes = new Uint8Array(binary);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Load (or reload) the BlindRSA suite and issuer private key.
 */
async function ensureIssuerLoaded() {
  if (_blindRsaSuite && _issuerPrivateKey) return;

  const { BlindRSA, Params } = await import('@cloudflare/blindrsa-ts');

  // Create the suite using RSABSSA-SHA384-PSS-Randomized (RFC 9474 standard)
  const suite = new BlindRSA(Params.RSABSSA_SHA384_PSS_Randomized);

  // Load private key PEM
  let pemData = ISSUER_PRIVATE_KEY_PEM;
  if (!pemData) {
    pemData = fs.readFileSync(ISSUER_PRIVATE_KEY_PATH, 'utf-8');
  }

  // Parse PEM to DER (raw binary)
  const derBytes = pemToDer(pemData);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    derBytes,
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['sign']
  );

  _blindRsaSuite = suite;
  _issuerPrivateKey = privateKey;
}

/**
 * Check the token issuance rate limit for one enrollment.
 * @param {string} relayToken - Server-minted enrollment token (audit H11: NOT
 *   the client-supplied deviceId, which any family member can claim).
 * @returns {boolean} true if allowed
 */
function checkTokenRateLimit(relayToken) {
  const now = Date.now();
  let limiter = tokenRateLimiters.get(relayToken);

  if (!limiter || now - limiter.windowStart > TOKEN_RATE_WINDOW_MS) {
    limiter = { count: 1, windowStart: now };
    tokenRateLimiters.set(relayToken, limiter);
    return true;
  }

  limiter.count++;
  if (limiter.count > TOKEN_RATE_LIMIT) {
    return false;
  }

  return true;
}

/**
 * Clean expired token rate limiters.
 */
function cleanTokenRateLimiters() {
  const now = Date.now();
  for (const [key, limiter] of tokenRateLimiters) {
    if (now - limiter.windowStart > TOKEN_RATE_WINDOW_MS * 2) {
      tokenRateLimiters.delete(key);
    }
  }
}

// ─── Configuration ───────────────────────────────────────────────────────────

const RELAY_PORT = parseInt(process.env.RELAY_PORT || process.env.PORT || '8080', 10);
const POOL_PORT = parseInt(process.env.POOL_PORT || RELAY_PORT.toString(), 10);
const API_PORT = parseInt(process.env.API_PORT || process.env.PORT || '8080', 10);
const WS_PORT = parseInt(process.env.WS_PORT || process.env.PORT || '8080', 10);
const MAX_CLIENTS_PER_FAMILY = parseInt(process.env.MAX_CLIENTS_PER_FAMILY || '50', 10);
const MAX_FAMILIES = parseInt(process.env.MAX_FAMILIES || '100', 10);
const MAX_DEVICES_PER_FAMILY = parseInt(process.env.MAX_DEVICES_PER_FAMILY || '20', 10);
const RATE_LIMIT_MESSAGES = parseInt(process.env.RATE_LIMIT_MESSAGES || '100', 10);
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const TOKEN_TTL_MS = parseInt(process.env.TOKEN_TTL_MS || '2592000000', 10); // 30 days default

// ─── TLS ─────────────────────────────────────────────────────────────────────

const TLS_CERT_PATH = process.env.TLS_CERT;
const TLS_KEY_PATH = process.env.TLS_KEY;

// ─── State Persistence ──────────────────────────────────────────────────────────

/** File path for persisting relay state across restarts. */
const STATE_FILE =
  process.env.RELAY_STATE_FILE ||
  (RELAY_DATA_DIR ? path.join(RELAY_DATA_DIR, 'relay-state.json') : './relay-state.json');

// ─── Voice Assistant OAuth2 & Keys ──────────────────────────────────────────────

/**
 * Cloud voice-assistant integration (Alexa / Google Assistant) is DISABLED by
 * default (opt in with ASSISTANT_INTEGRATION=true). Siri is unaffected
 * (fully on-device).
 *
 * KEY CUSTODY (the fix for the earlier zero-knowledge break):
 *   The relay holds ONLY the assistant RSA *public* key — never the private
 *   key. Clients seal the family key to that public key; only the deployed
 *   assistant webhook (Cloud Function / Lambda), which holds the private key
 *   in its own environment (ASSISTANT_PRIVATE_KEY), can decrypt it, and only
 *   transiently while answering a voice request.
 *
 *   The relay stores all ciphertext plus the sealed family-key blob, but with
 *   no private key it is cryptographically unable to read any of it. Generate
 *   the keypair out of band with `node assistant-keygen.js` and provision the
 *   public half here (ASSISTANT_PUBLIC_KEY or keys/assistant-public-key.pem),
 *   the private half to the webhook ONLY. Endpoints fail closed if the public
 *   key is not provisioned.
 *
 * UNSUPPORTED IN v1.31.0. No shipped client speaks this flow — the app's
 * `pairingCode` (src/setup/self-host.ts) is the unrelated signed-relay-address
 * concept, and nothing in the client calls /oauth/authorize or
 * /api/oauth/pair. The endpoints exist for an assistant webhook that is not
 * deployed. The account-linking hardening below (CSPRNG codes, constant-time
 * lookup, session TTL, per-IP and per-code budgets, redirect_uri allowlist) is
 * therefore defence for an opt-in deploy, not for the default one: leave
 * ASSISTANT_INTEGRATION unset in production. Turning it on additionally
 * requires ASSISTANT_REDIRECT_URIS, since an empty allowlist refuses every
 * link attempt.
 *
 * Operator knobs, all optional, all per minute unless noted:
 *   ASSISTANT_REDIRECT_URIS   required; comma-separated, exact match
 *   OAUTH_SESSION_TTL_MS      600000  pairing-session lifetime
 *   OAUTH_AUTHORIZE_LIMIT     15      /oauth/authorize per source IP
 *   OAUTH_POLL_LIMIT          120     /oauth/status + /api/oauth/pair per IP
 *   OAUTH_MISS_LIMIT          10      unknown-code lookups per IP (guessing)
 *   OAUTH_PAIR_MAX_ATTEMPTS   5       submissions per pairing code
 *   OAUTH_MAX_SESSIONS        1000    live pairing sessions, process-wide
 * Raise the poll budget if several household members link at once from behind
 * one NAT; it bounds traffic, not guessing (OAUTH_MISS_LIMIT does that).
 */
const ASSISTANT_INTEGRATION = process.env.ASSISTANT_INTEGRATION === 'true';

const ASSISTANT_PUBLIC_KEY_PATH =
  process.env.ASSISTANT_PUBLIC_KEY_PATH || path.join(__dirname, 'keys', 'assistant-public-key.pem');

let assistantPublicKeyPem = null;

/**
 * Load the voice-assistant RSA PUBLIC key (SPKI PEM). The relay NEVER holds or
 * generates the private key. Returns the PEM string, or null if not
 * provisioned (callers must fail closed).
 */
function getAssistantPublicKey() {
  if (assistantPublicKeyPem) return assistantPublicKeyPem;
  if (process.env.ASSISTANT_PUBLIC_KEY) {
    assistantPublicKeyPem = process.env.ASSISTANT_PUBLIC_KEY;
    return assistantPublicKeyPem;
  }
  try {
    if (fs.existsSync(ASSISTANT_PUBLIC_KEY_PATH)) {
      assistantPublicKeyPem = fs.readFileSync(ASSISTANT_PUBLIC_KEY_PATH, 'utf-8');
      return assistantPublicKeyPem;
    }
  } catch (err) {
    console.error('[assistant-keys] Failed to read public key:', err.message);
  }
  return null;
}

/**
 * Map<accessToken, { familyId: string, encryptedMasterKey: string, expiresAt: number }>
 */
const oauthTokens = new Map();

/**
 * Map<pairingCode, { sessionId: string, redirectUri: string, state: string, scope: string, linked: boolean, familyId: string, encryptedMasterKey: string, authCode: string, createdAt: number, attempts: number }>
 */
const oauthSessions = new Map();

/**
 * Redirect URIs an assistant vendor is allowed to be sent back to, as an exact
 * match. Comma-separated in ASSISTANT_REDIRECT_URIS. Empty means "no client is
 * registered", which fails closed — /oauth/authorize rejects everything, the
 * same posture as /api/assistant/public-key returning 503 when no key has been
 * provisioned. Without this the relay stored whatever redirect_uri the query
 * string carried and later handed it back from /oauth/status with the
 * authorization code appended: a textbook open redirect that leaks the code.
 */
const ASSISTANT_REDIRECT_URIS = (process.env.ASSISTANT_REDIRECT_URIS || '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

/**
 * How long an account-linking session stays usable. `createdAt` was already
 * written but never read, so sessions that never completed an exchange lived
 * for the life of the process and the guessable-code keyspace only ever grew.
 */
const OAUTH_SESSION_TTL_MS = parseInt(process.env.OAUTH_SESSION_TTL_MS || '600000', 10); // 10 min

/** Submissions a single pairing code tolerates before the session is destroyed. */
const OAUTH_PAIR_MAX_ATTEMPTS = parseInt(process.env.OAUTH_PAIR_MAX_ATTEMPTS || '5', 10);

/**
 * Per-IP /oauth/status polls per minute. The linking page polls every 1.5s
 * (~40/min), and a household behind one NAT can have two people linking at
 * once, so the budget is 3x one client rather than 1.5x — this limit exists to
 * bound total traffic, not to bound guessing (OAUTH_MISS_LIMIT does that), so
 * headroom here costs nothing.
 */
const OAUTH_POLL_LIMIT = parseInt(process.env.OAUTH_POLL_LIMIT || '120', 10);

/** Per-IP *misses* per minute across /oauth/status and /api/oauth/pair — the guessing budget. */
const OAUTH_MISS_LIMIT = parseInt(process.env.OAUTH_MISS_LIMIT || '10', 10);

/**
 * Per-IP GET /oauth/authorize per minute. This is the only unauthenticated
 * route that ALLOCATES server state (a pairing session), so it needs its own
 * budget: a human clicks "link account" once. Without it, the session map — and
 * therefore the constant-time scan in findPairingSession — grows at whatever
 * rate a single host can issue requests.
 */
const OAUTH_AUTHORIZE_LIMIT = parseInt(process.env.OAUTH_AUTHORIZE_LIMIT || '15', 10);

/**
 * Hard ceiling on live pairing sessions. The per-IP budget above bounds a
 * single host; this bounds a distributed one, and it is what keeps
 * findPairingSession's O(n) scan a bounded cost (~0.1 ms at this size) instead
 * of an attacker-controlled one. A family relay never has more than a handful
 * of concurrent link attempts, so 1000 is three orders of magnitude of slack.
 */
const OAUTH_MAX_SESSIONS = parseInt(process.env.OAUTH_MAX_SESSIONS || '1000', 10);

/**
 * Pairing-code alphabet: uppercase base32-ish with the characters that get
 * misread aloud or mistyped removed (0/O, 1/I/L, U). 30^8 ≈ 6.6e11 codes
 * against the old 10^6, which a single host could walk in minutes.
 */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const PAIRING_CODE_LENGTH = 8;

/**
 * A pairing code is a bearer credential — whoever holds it can complete the
 * account link — so it comes from the CSPRNG. Math.random() is a seeded,
 * observable PRNG: recovering its state from a couple of issued codes is a
 * published attack, and V8 makes no unpredictability claim at all.
 * crypto.randomInt is rejection-sampled, so no modulo bias across the
 * 30-character alphabet.
 */
function generatePairingCodeString() {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

/**
 * Look up a pairing session in constant time with respect to the code.
 *
 * A plain `oauthSessions.get(code)` compares strings with an early-exit memcmp
 * inside a hash bucket, which leaks how much of a guess was correct. This scans
 * every live session with timingSafeEqual and no early return, so the work is a
 * function of the session count, not of how close the guess was.
 *
 * Length is not secret (the format is fixed and printed on the linking page),
 * so a wrong-length code short-circuits — and it has to, because
 * timingSafeEqual throws on mismatched lengths.
 *
 * Expired sessions are treated as absent and evicted here, so TTL is enforced
 * on the read path rather than waiting for the hourly sweep.
 *
 * ponytail: known ceiling — this is O(live sessions) per lookup where
 * `oauthSessions.get()` was O(1), which is only acceptable because
 * OAUTH_MAX_SESSIONS caps n. Measured, the scan costs ~0.1 ms at n=1000 and
 * ~2 ms at n=20000; without the cap and the /oauth/authorize budget an
 * unauthenticated caller would choose n. If the session count ever needs to be
 * large, drop back to Map.get plus an explicit createdAt check: at a 30^8
 * CSPRNG keyspace with a 10-misses/min budget, the timing channel this defends
 * against is theoretical and the amplification is not.
 *
 * @param {unknown} submitted - Untrusted pairing code from the request.
 * @returns {{ code: string, session: object } | null}
 */
function findPairingSession(submitted) {
  if (typeof submitted !== 'string' || Buffer.byteLength(submitted) !== PAIRING_CODE_LENGTH) {
    return null;
  }
  const submittedBuf = Buffer.from(submitted);
  const now = Date.now();
  let found = null;

  for (const [code, session] of oauthSessions) {
    if (Buffer.byteLength(code) !== PAIRING_CODE_LENGTH) continue;
    const match = crypto.timingSafeEqual(Buffer.from(code), submittedBuf);
    if (match) found = { code, session }; // no break — constant work per session
  }

  if (found && now - found.session.createdAt > OAUTH_SESSION_TTL_MS) {
    oauthSessions.delete(found.code);
    return null;
  }
  return found;
}

/**
 * Evict pairing sessions past their TTL. Called from the hourly sweep purely to
 * bound memory; findPairingSession is what makes expiry security-relevant.
 */
function cleanOauthSessions() {
  const now = Date.now();
  let removed = 0;
  for (const [code, session] of oauthSessions) {
    if (now - session.createdAt > OAUTH_SESSION_TTL_MS) {
      oauthSessions.delete(code);
      removed++;
    }
  }
  return removed;
}


// ─── Pool Server ────────────────────────────────────────────────────────────────

const { PoolStore } = require('./pool/store');
const { handlePoolRequest, setUsedTokensStore } = require('./pool/pool-server');
const { seedTestData } = require('./seed-pool');
const poolStore = new PoolStore();
// Seed test data on startup
seedTestData(poolStore);
// Wire the used-tokens store into the pool server
setUsedTokensStore(usedTokensStore);

/**
 * Serialize relay state to a plain object (JSON-compatible).
 */
function serializeState() {
  const enrolled = {};
  for (const [token, enrollment] of enrolledDevices) {
    enrolled[token] = enrollment;
  }

  const families = {};
  for (const [familyId, tokens] of familyDeviceTokens) {
    families[familyId] = Array.from(tokens);
  }

  const tokens = {};
  for (const [token, data] of oauthTokens) {
    tokens[token] = data;
  }

  const usedInvites = {};
  for (const [key, expiresAt] of usedInviteSignatures) {
    usedInvites[key] = expiresAt;
  }

  const founders = {};
  for (const [familyId, keys] of familyFounderKeys) {
    founders[familyId] = Array.from(keys);
  }

  return {
    enrolledDevices: enrolled,
    familyDeviceTokens: families,
    usedInviteSignatures: usedInvites,
    familyFounderKeys: founders,
    oauthTokens: tokens,
  };
}

/**
 * Deserialize and restore relay state from a plain object.
 */
function deserializeState(saved) {
  if (!saved) return;

  if (saved.enrolledDevices) {
    for (const [token, enrollment] of Object.entries(saved.enrolledDevices)) {
      // Only load non-expired tokens
      if (Date.now() <= enrollment.expiresAt) {
        enrolledDevices.set(token, enrollment);
        // Rebuild family device tracking
        if (!familyDeviceTokens.has(enrollment.familyId)) {
          familyDeviceTokens.set(enrollment.familyId, new Set());
        }
        familyDeviceTokens.get(enrollment.familyId).add(token);
      }
    }
  }

  if (saved.usedInviteSignatures) {
    if (Array.isArray(saved.usedInviteSignatures)) {
      // Legacy format: array of raw familyInviteToken JSON strings. Convert
      // to the canonical `${familyId}:${nonce}` key; entries without a nonce
      // cannot be replayed under the new scheme (nonce-less invites are now
      // rejected outright) so they are dropped.
      for (const raw of saved.usedInviteSignatures) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.familyId && parsed.nonce) {
            usedInviteSignatures.set(
              `${parsed.familyId}:${parsed.nonce}`,
              parsed.expiresAt || Date.now(),
            );
          }
        } catch {
          // Malformed legacy entry — skip
        }
      }
    } else {
      for (const [key, expiresAt] of Object.entries(saved.usedInviteSignatures)) {
        usedInviteSignatures.set(key, expiresAt);
      }
    }
  }

  if (saved.familyFounderKeys) {
    for (const [familyId, keys] of Object.entries(saved.familyFounderKeys)) {
      familyFounderKeys.set(familyId, new Set(keys));
    }
  }

  if (saved.oauthTokens) {
    for (const [token, data] of Object.entries(saved.oauthTokens)) {
      if (Date.now() <= data.expiresAt) {
        oauthTokens.set(token, data);
      }
    }
  }
}

let _saveTimeout = null;

/**
 * Debounced save of relay state to disk.
 * Writes at most once per 500ms to avoid hammering the filesystem.
 */
function persistState() {
  if (_saveTimeout) clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    try {
      const data = serializeState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[persist] Failed to save state: ${err.message}`);
    }
  }, 500);
}

/**
 * Load relay state from disk on startup.
 */
function loadStateFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      deserializeState(saved);
      console.log(`[persist] Loaded state: ${enrolledDevices.size} enrollments, ${usedInviteSignatures.size} used invites`);
    }
  } catch (err) {
    console.warn(`[persist] Failed to load state: ${err.message}. Starting fresh.`);
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * Map<familyId, Set<WebSocket>>
 */
const familyRooms = new Map();

/**
 * Map<WebSocket, { familyId: string, deviceId: string, relayToken: string }>
 */
const clientInfo = new Map();

/**
 * Map<deviceId, WebSocket>
 */
const deviceSockets = new Map();

/**
 * Map<relayToken, { deviceId: string, familyId: string, enrolledAt: number }>
 * Enrolled devices that have completed POST /enroll.
 */
const enrolledDevices = new Map();

/**
 * Map<relayToken, { count: number, windowStart: number }>
 * Rate limiting counters keyed by relay token.
 */
const rateLimiters = new Map();

/**
 * Map<familyId, Set<string>> — relay tokens per family for enforcement.
 */
const familyDeviceTokens = new Map();

/**
 * Map<inviteKey, expiresAt> — used invite nonces (replay protection).
 * Keyed on `${familyId}:${nonce}` — canonical fields from the SIGNED payload —
 * rather than the raw familyInviteToken string, so re-serializing the JSON
 * (reordered keys, whitespace) cannot bypass one-time-use enforcement.
 * Entries carry the invite's expiresAt so the hourly sweep can evict them
 * once the invite could no longer be accepted anyway; memory stays bounded.
 */
const usedInviteSignatures = new Map();

/**
 * Map<familyId, Set<signerKey>> — family membership registry of Ed25519
 * signing keys authorized to issue invites for a family.
 *
 * The invite signature used to be verified against the signer key EMBEDDED IN
 * THE INVITE ITSELF (deviceId), so anyone could mint a keypair, pick any
 * familyId, self-sign, and enroll. The registry closes that: the first
 * enrollment for a previously-unseen familyId records the inviter's signing
 * key as the founding member; every later enrollment for that familyId
 * requires the invite's signer to be a key already recorded for it.
 *
 * KNOWN CEILING (documented in GOAL_PROMPT_NOTES.md): /enroll only receives
 * the joiner's X25519 box public key (deviceToken), never the joiner's
 * Ed25519 signing key, and the relay cannot derive one from the other. So the
 * registry can only ever hold founding signers — until the client also sends
 * its signing key at enrollment, only the founding device can issue invites
 * this relay will accept.
 */
const familyFounderKeys = new Map();

// ─── Ed25519 Signature Verification ──────────────────────────────────────────

/**
 * Verify an Ed25519 signature using tweetnacl (pure JS, zero native deps).
 *
 * tweetnacl takes raw 32-byte Ed25519 public keys (no DER/SPKI wrapping),
 * matching libsodium's crypto_sign_verify_detached format used by the client.
 *
 * @param {string} message - The original message that was signed.
 * @param {string} signature - Base64-encoded signature.
 * @param {string} publicKey - Base64-encoded Ed25519 public key (raw 32 bytes).
 * @returns {boolean} Whether the signature is valid.
 */
function verifyEd25519Signature(message, signature, publicKey) {
  try {
    const nacl = require('tweetnacl');
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = Buffer.from(signature, 'base64');
    const keyBytes = Buffer.from(publicKey, 'base64');
    return nacl.sign.detached.verify(msgBytes, sigBytes, keyBytes);
  } catch (err) {
    console.warn(`[crypto] Signature verification error: ${err.message}`);
    return false;
  }
}

// ─── Shared Cleanup ──────────────────────────────────────────────────────────

/**
 * Remove a client from all internal state.
 */
function removeClient(ws) {
  if (ws._pingInterval) {
    clearInterval(ws._pingInterval);
    ws._pingInterval = null;
  }

  const info = clientInfo.get(ws);
  if (info) {
    const room = familyRooms.get(info.familyId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) {
        familyRooms.delete(info.familyId);
      }
    }

    const currentSocket = deviceSockets.get(info.deviceId);
    if (currentSocket === ws) {
      deviceSockets.delete(info.deviceId);
    }

    clientInfo.delete(ws);
  }
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────

/**
 * Check whether a key has exceeded its rate limit in the current 1-minute
 * window. Returns true if the request should be allowed.
 *
 * The key is a relay token for WebSocket traffic and a namespaced source-IP
 * string (`enroll:<ip>`, `oauth-status:<ip>`, `oauth-miss:<ip>`) for the
 * unauthenticated HTTP endpoints, which have no token to key on. One limiter,
 * one sweep, one map — the namespace prefix keeps the two keyspaces from
 * colliding.
 *
 * @param {string} key
 * @param {number} [limit] - Requests allowed per window; defaults to the
 *   WebSocket message budget.
 */
function checkRateLimit(key, limit = RATE_LIMIT_MESSAGES) {
  const now = Date.now();
  let limiter = rateLimiters.get(key);

  if (!limiter || now - limiter.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Start a new window
    limiter = { count: 1, windowStart: now };
    rateLimiters.set(key, limiter);
    return true;
  }

  limiter.count++;
  if (limiter.count > limit) {
    return false; // Rate limited
  }

  return true;
}

/**
 * Source IP to rate-limit on.
 *
 * The relay is documented as running behind a reverse proxy for TLS, where
 * req.socket.remoteAddress is the proxy for every client — keying on it there
 * would turn a per-IP budget into a global one and lock out whole families.
 * But X-Forwarded-For is caller-controlled, so honouring it on a directly
 * exposed relay makes the limiter decorative: an attacker just varies the
 * header. Hence the explicit TRUST_PROXY opt-in, which the operator sets only
 * when something in front is actually rewriting the header.
 *
 * Both halves have to be true — TRUST_PROXY=true here AND the proxy actually
 * setting X-Forwarded-For. Get one without the other and every per-IP budget
 * silently degrades to a single relay-wide budget, which is worse than no
 * limiter because it locks out real families. The warnings below shout rather
 * than letting it fail quietly — there are three ways to get here and the
 * nastiest one (both halves false) used to be silent, because "no header and
 * no TRUST_PROXY" looks like agreement while actually being the recommended
 * nginx block in docs/self-host-security.md, which sets X-Forwarded-Proto and
 * not X-Forwarded-For.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

/**
 * How many trailing X-Forwarded-For entries this operator's own infrastructure
 * appends. 1 is the single-nginx case; a CDN in front of nginx makes it 2. The
 * key is taken from position `length - HOPS`, so with the default the rightmost
 * (proxy-written) entry wins and forged leading entries are ignored.
 *
 * A header with FEWER entries than HOPS was not written by the expected chain,
 * so it is discarded entirely rather than clamped to index 0 — clamping would
 * hand a caller sending a single forged entry the key it asked for, which is
 * precisely the bypass the rightmost rule exists to close.
 */
const TRUSTED_PROXY_HOPS = Math.max(parseInt(process.env.TRUSTED_PROXY_HOPS, 10) || 1, 1);

if (!TRUST_PROXY) {
  // docs/self-host-security.md requires a reverse proxy in front of the relay,
  // so an unset TRUST_PROXY is always wrong in a real deployment: every per-IP
  // budget is keyed on the proxy's address and collapses into one relay-wide
  // budget, which one host can exhaust to deny /enroll to every family. Warned
  // at boot because the per-request check below can only spot it when the proxy
  // is on the same host or the same Docker network.
  console.warn(
    '[rate-limit] TRUST_PROXY is not set. If this relay is behind a reverse proxy (docs/self-host-security.md requires one), every per-IP rate-limit budget is keyed on the proxy address and collapses to a single relay-wide budget. Set TRUST_PROXY=true and have the proxy append X-Forwarded-For.'
  );
}

/** Addresses that can only be a proxy or sidecar, never a real internet peer. */
function isPrivateAddr(key) {
  return (
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(key) ||
    key === '0:0:0:0' || // ::1 and :: after /64 bucketing
    /^f[cd]/i.test(key) // fc00::/7 unique-local
  );
}

let proxyMismatchWarned = false;
function warnProxyMismatch(hasForwarded, peerKey) {
  if (proxyMismatchWarned) return;
  let message;
  if (TRUST_PROXY && !hasForwarded) {
    message =
      '[rate-limit] TRUST_PROXY=true but no X-Forwarded-For header arrived. Every per-IP budget is collapsing to one relay-wide budget. Add `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` to the proxy, or unset TRUST_PROXY.';
  } else if (!TRUST_PROXY && hasForwarded) {
    message =
      '[rate-limit] X-Forwarded-For is present but TRUST_PROXY is not set, so per-IP budgets are keyed on the proxy address and collapsing to one relay-wide budget. Set TRUST_PROXY=true if this relay really is behind a proxy you control.';
  } else if (!TRUST_PROXY && !hasForwarded && isPrivateAddr(peerKey)) {
    // The silent case: nothing disagrees, but the peer is a loopback/private
    // address, so something in front is terminating the connection and no
    // X-Forwarded-For is reaching us. Every client shares the key `peerKey`.
    message = `[rate-limit] Requests are arriving from ${peerKey} with no X-Forwarded-For, so every client shares one rate-limit budget and one host can lock out the whole relay. Set TRUST_PROXY=true and add \`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\` to the proxy in front.`;
  } else {
    return;
  }
  proxyMismatchWarned = true;
  console.warn(message);
}

/**
 * Collapse an address to the unit a rate limit should actually be keyed on.
 *
 * IPv4 is used as-is. IPv6 is bucketed to its /64: a residential or cloud
 * customer is routinely delegated a whole /64 (or shorter), so keying on the
 * full /128 would hand one attacker 2^64 distinct limiter keys and make every
 * per-IP budget on this server decorative. /64 is the smallest block an
 * operator is guaranteed not to be sharing with a stranger.
 *
 * Hextets are normalised (leading zeros stripped, `::` expanded) so that the
 * same address written two ways cannot buy two buckets.
 */
function ipKey(addr) {
  if (!addr.includes(':')) return addr; // IPv4

  const bare = addr.split('%')[0]; // drop any zone index (fe80::1%eth0)
  const mapped = bare.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1]; // IPv4-mapped IPv6 — an IPv4 host

  const [head, tail] = bare.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const parts =
    tail === undefined
      ? headParts
      : [
          ...headParts,
          ...Array(Math.max(8 - headParts.length - tailParts.length, 0)).fill('0'),
          ...tailParts,
        ];

  return parts
    .slice(0, 4)
    .map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16).toString(16) : h))
    .join(':');
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (TRUST_PROXY && forwarded) {
    warnProxyMismatch(true, null);
    // RIGHTMOST entry, not leftmost. The recommended nginx line
    // (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`) and
    // Caddy's default both APPEND the real peer to whatever the client sent,
    // so the leftmost entry is caller-controlled — taking it would let anyone
    // mint a fresh limiter bucket per request with a forged header and bypass
    // every budget on this server. The rightmost entry is the only one the
    // trusted proxy wrote. A proxy that overwrites instead of appending emits
    // a single entry, where rightmost and leftmost coincide, so this is
    // correct for both styles. TRUSTED_PROXY_HOPS moves the pick left by one
    // per extra proxy the operator declares (CDN in front of nginx).
    const hops = forwarded.split(',');
    if (hops.length >= TRUSTED_PROXY_HOPS) {
      return ipKey(hops[hops.length - TRUSTED_PROXY_HOPS].trim());
    }
    // Too few entries to have come through the declared chain — fail closed on
    // the real peer rather than trusting a caller-supplied entry.
  }
  const peerKey = ipKey(req.socket.remoteAddress || 'unknown');
  warnProxyMismatch(Boolean(forwarded), peerKey);
  return peerKey;
}

/**
 * Enrollment attempts per source IP per minute. Sized for a household behind
 * one NAT re-enrolling several devices, not for a single device: enrollment is
 * a once-per-device event, so anything sustained is a flood. Each attempt costs
 * a tweetnacl Ed25519 verify on a 0.5-CPU container (audit L1).
 */
const ENROLL_RATE_LIMIT = parseInt(process.env.ENROLL_RATE_LIMIT || '20', 10);

/**
 * Reject with 429 unless the caller is within its per-IP budget for `bucket`.
 * @returns {boolean} true if the request was rejected (response already sent).
 */
function rejectIfRateLimited(req, res, bucket, limit) {
  if (checkRateLimit(`${bucket}:${clientIp(req)}`, limit)) return false;
  res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
  res.end(JSON.stringify({ error: 'Rate limit exceeded. Try again in a minute.' }));
  return true;
}

/**
 * Reset rate limiters periodically to prevent memory leaks.
 */
function cleanRateLimiters() {
  const now = Date.now();
  for (const [token, limiter] of rateLimiters) {
    if (now - limiter.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimiters.delete(token);
    }
  }
}

// Clean rate limiters every 5 minutes
setInterval(cleanRateLimiters, 5 * 60_000);
setInterval(() => cleanPricesState(), 5 * 60_000);

// ─── HTTP Server ─────────────────────────────────────────────────────────────

// ─── HTTP / HTTPS Server ──────────────────────────────────────────────────────
// If TLS_CERT and TLS_KEY env vars are set, create HTTPS server.
// Otherwise, create plain HTTP (expected to run behind reverse proxy for TLS).

const https = require('https');

function createServer(requestListener) {
  if (TLS_CERT_PATH && TLS_KEY_PATH) {
    try {
      const tlsOptions = {
        cert: fs.readFileSync(TLS_CERT_PATH),
        key: fs.readFileSync(TLS_KEY_PATH),
      };
      console.log('[tls] Using TLS certificates — server will use HTTPS/WSS');
      return https.createServer(tlsOptions, requestListener);
    } catch (err) {
      console.warn(`[tls] Failed to load TLS certs: ${err.message}. Falling back to HTTP.`);
    }
  }
  return http.createServer(requestListener);
}

const server = createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check.
  //
  // Liveness stays unauthenticated — the Dockerfile HEALTHCHECK, the compose
  // healthcheck and the client's testRelayConnection() all just need a 200 —
  // but the aggregate counters that used to ship with it are the same class of
  // operational data /stats was hardened to withhold (audit H4's tail), and
  // the server-wide Access-Control-Allow-Origin: * made them readable by any
  // web page a family member visited. They now require an enrolled device's
  // relayToken, exactly like /stats.
  if (req.url === '/health' && req.method === 'GET') {
    const healthAuth = req.headers['authorization'];

    if (!healthAuth) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '2.0' }));
      return;
    }

    // No cross-origin reads of operational data
    res.removeHeader('Access-Control-Allow-Origin');

    if (!healthAuth.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid Authorization header. Expected: Bearer <relayToken>' }));
      return;
    }

    const healthToken = healthAuth.slice('Bearer '.length).trim();
    const healthEnrollment = enrolledDevices.get(healthToken);
    if (!healthEnrollment || Date.now() > healthEnrollment.expiresAt) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid relay token' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      families: familyRooms.size,
      clients: clientInfo.size,
      enrolledDevices: enrolledDevices.size,
      version: '2.0',
    }));
    return;
  }

  // GET /relay/public-key — unauthenticated, returns issuer's public key PEM
  if (req.url === '/relay/public-key' && req.method === 'GET') {
    try {
      const publicKeyPath = process.env.ISSUER_PUBLIC_KEY_PATH ||
        path.join(__dirname, 'keys', 'issuer-public-key.pem');
      const publicKeyPem = process.env.ISSUER_PUBLIC_KEY ||
        fs.readFileSync(publicKeyPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(publicKeyPem);
    } catch (err) {
      console.warn('[public-key] Failed to load public key:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Issuer public key not configured' }));
    }
    return;
  }

  // POST /relay/request-token — authenticated, requires relayToken
  if (req.url === '/relay/request-token' && req.method === 'POST') {
    handleTokenRequest(req, res);
    return;
  }

  // Device enrollment
  if (req.url === '/enroll' && req.method === 'POST') {
    // Checked before the body is read, so a flood costs neither the buffering
    // nor the Ed25519 verify (audit L1).
    if (rejectIfRateLimited(req, res, 'enroll', ENROLL_RATE_LIMIT)) return;

    collectBody(req, 4096).then((body) => {
      // Streaming cap exceeded (connection already destroyed) or read error
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large (max 4096 bytes)' }));
        return;
      }

      try {
        const data = JSON.parse(body);
        const { deviceToken, familyInviteToken } = data;

        if (!deviceToken || !familyInviteToken) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'deviceToken and familyInviteToken are required',
          }));
          return;
        }

        // Parse the family invite token
        let invite;
        try {
          invite = JSON.parse(familyInviteToken);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid familyInviteToken format' }));
          return;
        }

        const { familyId, deviceId: inviterDeviceId, expiresAt, nonce, signature } = invite;

        if (!familyId || !inviterDeviceId || !expiresAt || !signature) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid invite token structure' }));
          return;
        }

        // Require the per-invite nonce. The client has always minted one
        // (family.ts mints 16 random bytes into the signed payload), and the
        // nonce is what one-time-use enforcement is keyed on — accepting a
        // nonce-less invite would reopen the re-serialization replay bypass.
        if (!nonce || typeof nonce !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invite token is missing the required nonce' }));
          return;
        }

        // Check expiry
        if (Date.now() > expiresAt) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invite token has expired' }));
          return;
        }

        // Verify invite signature using Ed25519.
        // The payload must match the client's serializeTokenPayload exactly,
        // including the nonce field (added for one-time-use enforcement).
        const invitePayload = JSON.stringify({
          familyId,
          deviceId: inviterDeviceId,
          expiresAt,
          nonce,
        });

        const signatureValid = verifyEd25519Signature(
          invitePayload,
          signature,
          inviterDeviceId,
        );

        if (!signatureValid) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid invite signature' }));
          return;
        }

        // Membership registry: a valid signature only proves the invite was
        // signed by the key embedded in it — it says nothing about whether
        // that key belongs to this family. For a family the relay has seen
        // before, the signer must already be a registered signing key;
        // otherwise anyone could self-sign an invite into any familyId.
        // A previously-unseen familyId is founded by this enrollment and the
        // inviter's signing key is recorded below as the founding member.
        const registeredSigners = familyFounderKeys.get(familyId);
        if (registeredSigners && !registeredSigners.has(inviterDeviceId)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invite signer is not a registered member of this family' }));
          return;
        }

        // Replay protection: keyed on the signed per-invite nonce (scoped to
        // the familyId), NOT the raw familyInviteToken string — re-serializing
        // the same JSON (reordered keys, whitespace) must not mint a fresh
        // usable invite.
        const inviteReplayKey = `${familyId}:${nonce}`;
        if (usedInviteSignatures.has(inviteReplayKey)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invite token has already been used' }));
          return;
        }

        // Check family limits against enrollments (familyDeviceTokens), not
        // familyRooms — the latter is only populated by the WebSocket path,
        // so counting it let enrollments grow without bound. Joining an
        // already-enrolled family is allowed even at capacity; only founding
        // a NEW family counts against MAX_FAMILIES.
        if (!familyDeviceTokens.has(familyId) && familyDeviceTokens.size >= MAX_FAMILIES) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server at maximum family capacity' }));
          return;
        }

        // Check devices per family limit
        const familyTokens = familyDeviceTokens.get(familyId);
        if (familyTokens && familyTokens.size >= MAX_DEVICES_PER_FAMILY) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Family at maximum device capacity' }));
          return;
        }

        // Mark invite as used (replay protection). Keep the entry until the
        // invite's own expiry passes; the hourly sweep evicts it after that.
        usedInviteSignatures.set(inviteReplayKey, expiresAt);

        // Record the founding signer for a previously-unseen familyId.
        if (!familyFounderKeys.has(familyId)) {
          familyFounderKeys.set(familyId, new Set([inviterDeviceId]));
        }

        // Generate a relay token (opaque routing token)
        const relayToken = crypto.randomBytes(32).toString('hex');

        // Store enrollment with TTL
        const now = Date.now();
        enrolledDevices.set(relayToken, {
          deviceId: deviceToken,
          familyId,
          enrolledAt: now,
          expiresAt: now + TOKEN_TTL_MS,
        });

        // Track family device count
        if (!familyDeviceTokens.has(familyId)) {
          familyDeviceTokens.set(familyId, new Set());
        }
        familyDeviceTokens.get(familyId).add(relayToken);

        persistState();

        console.log(`[enroll] Device "${deviceToken.slice(0, 12)}..." enrolled in family "${familyId}"`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          relayToken,
          familyId,
        }));
      } catch (err) {
        console.warn(`[enroll] Error: ${err.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Stats page — authenticated, aggregate counters only.
  // Previously this endpoint was unauthenticated and returned every active
  // familyId plus a 12-char prefix of each connected device id (a stable
  // fingerprint), readable by any web page thanks to the server-wide
  // Access-Control-Allow-Origin: *. It now requires an enrolled device's
  // relayToken (the same fail-closed mechanism as POST /relay/request-token),
  // returns no per-family data at all, and suppresses the wildcard CORS
  // header on the response.
  if (req.url === '/stats' && req.method === 'GET') {
    // No cross-origin reads of operational data
    res.removeHeader('Access-Control-Allow-Origin');

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid Authorization header. Expected: Bearer <relayToken>' }));
      return;
    }

    const statsToken = authHeader.slice('Bearer '.length).trim();
    const statsEnrollment = enrolledDevices.get(statsToken);
    if (!statsEnrollment || Date.now() > statsEnrollment.expiresAt) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid relay token' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptime: process.uptime(),
      totalFamilies: familyDeviceTokens.size,
      totalClients: clientInfo.size,
      totalEnrolled: enrolledDevices.size,
      rateLimiters: rateLimiters.size,
      config: {
        maxFamilies: MAX_FAMILIES,
        maxDevicesPerFamily: MAX_DEVICES_PER_FAMILY,
        maxClientsPerFamily: MAX_CLIENTS_PER_FAMILY,
        rateLimitMessagesPerMin: RATE_LIMIT_MESSAGES,
        tokenTtlDays: Math.round(TOKEN_TTL_MS / 86400000),
      },
    }));
    return;
  }

  // Pool endpoints (unauthenticated, identity-free) — only when sharing port
  if (POOL_PORT === RELAY_PORT && req.url.startsWith('/api/pool/')) {
    return handlePoolRequest(req, res, poolStore);
  }

  // POST /api/extract/flyer — authenticated flyer price extraction
  if (req.url === '/api/extract/flyer' && req.method === 'POST') {
    const { handleExtractRequest } = require('./extract/extract-server');
    return handleExtractRequest(req, res, enrolledDevices);
  }

  // GET /api/prices/{deals,shelf}?fsa= — live prices from the operator's
  // scraper, read server-side from Turso (fails closed without TURSO_* env).
  if (req.url.startsWith('/api/prices/')) {
    return handlePricesRequest(req, res, enrolledDevices);
  }

  // Voice-assistant + OAuth account-linking endpoints (see ASSISTANT_INTEGRATION
  // above for why these are off by default).
  if (
    !ASSISTANT_INTEGRATION &&
    (req.url.startsWith('/api/assistant/') ||
      req.url.startsWith('/oauth/') ||
      req.url.startsWith('/api/oauth/'))
  ) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Voice assistant integration is disabled on this relay' }));
    return;
  }

  // GET /api/assistant/public-key — returns the voice-assistant PUBLIC key.
  // Fails closed if no public key has been provisioned (the relay never
  // generates one — see assistant-keygen.js).
  if (req.url === '/api/assistant/public-key' && req.method === 'GET') {
    const pubKey = getAssistantPublicKey();
    if (!pubKey) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Voice assistant public key not provisioned. Generate a keypair with assistant-keygen.js and set ASSISTANT_PUBLIC_KEY; the private key goes to the webhook only.',
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(pubKey);
    return;
  }

  // GET /oauth/authorize — account linking HTML page showing pairing code
  if (req.url.startsWith('/oauth/authorize') && req.method === 'GET') {
    // This is the only unauthenticated route that allocates server state, so it
    // is limited first — before the allowlist check, so a rejected caller
    // cannot probe which redirect_uris are registered for free either.
    if (rejectIfRateLimited(req, res, 'oauth-authorize', OAUTH_AUTHORIZE_LIMIT)) return;

    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const redirectUri = reqUrl.searchParams.get('redirect_uri');
    const state = reqUrl.searchParams.get('state');
    const scope = reqUrl.searchParams.get('scope') || '';
    const clientId = reqUrl.searchParams.get('client_id') || '';

    if (!redirectUri || !state) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing redirect_uri or state parameters');
      return;
    }

    // Exact match against the operator's registered URIs. Prefix matching would
    // accept https://oauth.example.com/cb.evil.net/, so it is deliberately not
    // used. An unset allowlist means no assistant client is registered and
    // every link attempt is refused.
    if (!ASSISTANT_REDIRECT_URIS.includes(redirectUri)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(
        ASSISTANT_REDIRECT_URIS.length === 0
          ? 'No assistant redirect_uri is registered on this relay. Set ASSISTANT_REDIRECT_URIS.'
          : 'redirect_uri is not registered on this relay'
      );
      return;
    }

    // Hard bound on allocated state. Sweep first (cheap, and most of the map is
    // usually expired), then refuse rather than grow without limit: an
    // unbounded map is both an OOM on a relay that also carries every family's
    // WebSocket sync and an unbounded cost for findPairingSession's scan.
    if (oauthSessions.size >= OAUTH_MAX_SESSIONS) {
      cleanOauthSessions();
      if (oauthSessions.size >= OAUTH_MAX_SESSIONS) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
        res.end('Too many pending account-linking sessions. Try again shortly.');
        return;
      }
    }

    const pairingCode = generatePairingCodeString();
    oauthSessions.set(pairingCode, {
      redirectUri,
      state,
      scope,
      clientId,
      linked: false,
      familyId: null,
      encryptedMasterKey: null,
      authCode: null,
      createdAt: Date.now(),
      attempts: 0
    });

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getAuthorizeHtml(pairingCode));
    return;
  }

  // GET /oauth/status — poll endpoint for pairing screen.
  //
  // Two budgets, because they bound different attacks: OAUTH_POLL_LIMIT caps
  // total polls per IP (the linking page needs ~40/min), and OAUTH_MISS_LIMIT
  // caps *misses* per IP across this endpoint and /api/oauth/pair. A legitimate
  // client polls a code it already has and never misses, so the miss budget is
  // spent only by someone walking the keyspace.
  if (req.url.startsWith('/oauth/status') && req.method === 'GET') {
    if (rejectIfRateLimited(req, res, 'oauth-status', OAUTH_POLL_LIMIT)) return;

    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const pairingCode = reqUrl.searchParams.get('pairingCode');
    if (!pairingCode) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing pairingCode' }));
      return;
    }

    const found = findPairingSession(pairingCode);
    if (!found) {
      if (rejectIfRateLimited(req, res, 'oauth-miss', OAUTH_MISS_LIMIT)) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found or expired' }));
      return;
    }
    const session = found.session;

    if (session.linked) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        linked: true,
        redirectUri: `${session.redirectUri}${session.redirectUri.includes('?') ? '&' : '?'}code=${session.authCode}&state=${session.state}`
      }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ linked: false }));
    return;
  }

  // POST /api/oauth/pair — pairing submission from mobile app
  if (req.url === '/api/oauth/pair' && req.method === 'POST') {
    if (rejectIfRateLimited(req, res, 'oauth-status', OAUTH_POLL_LIMIT)) return;

    collectBody(req, 4096).then((body) => {
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large (max 4096 bytes)' }));
        return;
      }
      try {
        const { pairingCode, familyId, encryptedMasterKey } = JSON.parse(body);

        // Resolve the code BEFORE validating the rest of the payload, so that a
        // malformed submission still costs the code one of its attempts —
        // otherwise the attempt budget below could be sidestepped by always
        // omitting a field.
        const found = pairingCode ? findPairingSession(pairingCode) : null;
        if (!found) {
          if (rejectIfRateLimited(req, res, 'oauth-miss', OAUTH_MISS_LIMIT)) return;
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired pairing code' }));
          return;
        }
        const session = found.session;

        // A pairing code links exactly one family. Without this, anyone who
        // learned the code after the legitimate link could overwrite familyId
        // and encryptedMasterKey and have the pending authorization mint a
        // token for THEIR family instead.
        //
        // Checked BEFORE the attempt counter is touched, deliberately: once a
        // session is linked its remaining budget is irrelevant, and burning it
        // would let a third party who knows the code destroy an
        // already-successful link before the vendor exchanges the authCode.
        if (session.linked) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'This pairing code has already been linked' }));
          return;
        }

        // Bounded attempts per code: a real app submits once. Anything past the
        // budget destroys the session, so a code that leaks (shoulder-surfed
        // off the linking page, say) cannot be probed indefinitely.
        //
        // Counted before the payload is validated, so the budget cannot be
        // sidestepped by always omitting a field.
        //
        // ponytail: known ceiling — a third party who learns an UNLINKED code
        // can spend its budget and force the owner to restart linking. That is
        // a denial of the link, not a hijack of it, the window is
        // OAUTH_SESSION_TTL_MS, and the alternative is per-caller attempt
        // state. Add that only if link-restart abuse is ever observed.
        session.attempts = (session.attempts || 0) + 1;
        if (session.attempts > OAUTH_PAIR_MAX_ATTEMPTS) {
          oauthSessions.delete(found.code);
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many attempts for this pairing code. Start linking again.' }));
          return;
        }

        if (!familyId || !encryptedMasterKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pairingCode, familyId, and encryptedMasterKey are required' }));
          return;
        }

        const authCode = crypto.randomBytes(16).toString('hex');
        session.linked = true;
        session.familyId = familyId;
        session.encryptedMasterKey = encryptedMasterKey;
        session.authCode = authCode;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  // POST /oauth/token — oauth2 token exchange
  if (req.url === '/oauth/token' && req.method === 'POST') {
    collectBody(req, 4096).then((body) => {
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large (max 4096 bytes)' }));
        return;
      }
      try {
        let params;
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('application/x-www-form-urlencoded')) {
          params = new URLSearchParams(body);
        } else {
          const parsed = JSON.parse(body);
          params = {
            get(key) { return parsed[key]; }
          };
        }

        const grantType = params.get('grant_type');
        const code = params.get('code');

        if (grantType !== 'authorization_code' || !code) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unsupported grant_type or missing authorization code' }));
          return;
        }

        // This path matches on authCode, not on the pairing code, so it does
        // not go through findPairingSession — which means it has to apply
        // OAUTH_SESSION_TTL_MS itself. Without this an expired-but-linked
        // session stayed exchangeable for a 1-year access token until the
        // hourly sweep happened to run, so the real window was ~1 hour rather
        // than the 10 minutes the TTL advertises.
        let foundCode = null;
        let foundSession = null;
        const nowMs = Date.now();
        for (const [pCode, session] of oauthSessions.entries()) {
          if (session.authCode === code) {
            if (nowMs - session.createdAt > OAUTH_SESSION_TTL_MS) {
              oauthSessions.delete(pCode);
              break; // expired: treat as no match
            }
            foundCode = pCode;
            foundSession = session;
            break;
          }
        }

        if (!foundSession) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired authorization code' }));
          return;
        }

        const accessToken = crypto.randomBytes(32).toString('hex');
        oauthTokens.set(accessToken, {
          familyId: foundSession.familyId,
          encryptedMasterKey: foundSession.encryptedMasterKey,
          expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 // 1 year
        });

        oauthSessions.delete(foundCode);
        persistState();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 31536000
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to exchange token: ' + err.message }));
      }
    });
    return;
  }

  // GET /api/assistant/list-data — fetches encrypted key and all Yjs updates
  if (req.url === '/api/assistant/list-data' && req.method === 'GET') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized. Missing Bearer token' }));
      return;
    }

    const accessToken = authHeader.slice('Bearer '.length).trim();
    const tokenData = oauthTokens.get(accessToken);

    if (!tokenData || Date.now() > tokenData.expiresAt) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired access token' }));
      return;
    }

    const { familyId, encryptedMasterKey } = tokenData;
    const { getAllUpdates } = require('./encrypted-store');
    const updates = getAllUpdates(familyId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      encryptedMasterKey,
      updates
    }));
    return;
  }

  // POST /api/assistant/submit-update — appends Yjs update and relays to WebSocket
  if (req.url === '/api/assistant/submit-update' && req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized. Missing Bearer token' }));
      return;
    }

    const accessToken = authHeader.slice('Bearer '.length).trim();
    const tokenData = oauthTokens.get(accessToken);

    if (!tokenData || Date.now() > tokenData.expiresAt) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired access token' }));
      return;
    }

    const { familyId } = tokenData;

    // Encrypted Yjs updates are small; 1MB is generous headroom while still
    // bounding what an authenticated-but-hostile webhook peer can buffer.
    collectBody(req, 1024 * 1024).then((body) => {
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large (max 1MB)' }));
        return;
      }
      try {
        const { listId, payload } = JSON.parse(body);
        if (!listId || !payload) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'listId and payload are required' }));
          return;
        }

        const { addUpdate } = require('./encrypted-store');
        addUpdate(familyId, listId, payload);

        // Broadcast to online family room clients
        const room = familyRooms.get(familyId);
        let relayed = 0;
        if (room) {
          room.forEach((client) => {
            if (client.readyState === client.OPEN) {
              sendTo(client, {
                type: 'update',
                familyId,
                deviceId: 'assistant-cloud',
                listId,
                payload,
              });
              relayed++;
            }
          });
        }

        console.log(`[assistant-update] Update persisted for family "${familyId}" list "${listId}". Relayed to ${relayed} clients.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to process update: ' + err.message }));
      }
    });
    return;
  }

  // Default 404
  res.writeHead(404);
  res.end('Not Found');
});

// ─── Pool HTTP Server (separate port for transport isolation) ──────────────
// When POOL_PORT differs from RELAY_PORT, bind a dedicated HTTP server for
// pool endpoints. This keeps contributions isolated from authenticated relay traffic.

let poolServer = null;
if (POOL_PORT !== RELAY_PORT) {
  poolServer = createServer((req, res) => {
    handlePoolRequest(req, res, poolStore);
  });
}

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server,
  maxPayload: 10 * 1024 * 1024, // 10MB max payload
});

wss.on('connection', (ws, req) => {
  console.log(`[connect] New WebSocket connection`);

  // Authentication is done via 'auth' message (not URL parameter).
  // Client sends { type: 'auth', relayToken: '...' } after WebSocket connects.
  // If auth doesn't arrive within 10s, close the connection.
  ws._authTimeout = setTimeout(() => {
    if (!ws._relayToken) {
      console.warn(`[auth] Connection timed out — closing unauthenticated socket`);
      sendTo(ws, {
        type: 'error',
        message: 'Authentication timeout. Send auth message within 10s.',
      });
      try { ws.close(4001, 'Authentication timeout'); } catch (_) {}
    }
  }, 10_000);

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      handleMessage(ws, message);
    } catch (err) {
      console.warn(`[error] Failed to parse message: ${err.message}`);
      sendTo(ws, {
        type: 'error',
        message: 'Invalid message format',
      });
    }
  });

  ws.on('close', () => {
    console.log(`[disconnect] Client disconnected`);
    removeClient(ws);
  });

  ws.on('error', (err) => {
    console.warn(`[error] WebSocket error: ${err.message}`);
    removeClient(ws);
  });

  // Ping/pong for keepalive
  ws._pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 30_000);
});

// ─── Message Handling ────────────────────────────────────────────────────────

/**
 * Handle an incoming relay message from a client.
 */
function handleMessage(sender, message) {
  switch (message.type) {
    case 'auth': {
      // Authenticate via relayToken in message body
      const { relayToken } = message;

      if (!relayToken) {
        sendTo(sender, {
          type: 'error',
          message: 'auth message requires relayToken',
        });
        return;
      }

      const enrollment = enrolledDevices.get(relayToken);
      if (!enrollment) {
        sendTo(sender, {
          type: 'error',
          message: 'Invalid relay token',
        });
        return;
      }

      // Check token expiry with sliding window
      if (Date.now() > enrollment.expiresAt) {
        enrolledDevices.delete(relayToken);
        // Also clean up from family device tracking
        const familyTokens = familyDeviceTokens.get(enrollment.familyId);
        if (familyTokens) {
          familyTokens.delete(relayToken);
          if (familyTokens.size === 0) familyDeviceTokens.delete(enrollment.familyId);
        }
        persistState();
        sendTo(sender, {
          type: 'error',
          message: 'Relay token has expired. Re-enroll to continue.',
        });
        console.log(`[auth] Rejected expired token for device "${enrollment.deviceId.slice(0, 12)}..."`);
        return;
      }

      // Sliding-window TTL: refresh expiry on successful auth
      enrollment.expiresAt = Date.now() + TOKEN_TTL_MS;
      persistState();

      sender._relayToken = relayToken;
      sender._enrollment = enrollment;
      // Clear auth timeout since we're authenticated
      clearTimeout(sender._authTimeout);

      sendTo(sender, {
        type: 'auth_ack',
        message: 'Authenticated',
        familyId: enrollment.familyId,
      });
      console.log(`[auth] WebSocket authenticated via message`);
      break;
    }

    case 'identity': {
      // Check authentication
      if (!sender._relayToken) {
        sendTo(sender, {
          type: 'error',
          message: 'Not authenticated. Send auth message first.',
        });
        return;
      }

      // Check rate limit
      if (!checkRateLimit(sender._relayToken)) {
        sendTo(sender, {
          type: 'error',
          message: 'Rate limit exceeded (max 100 messages/min)',
        });
        return;
      }

      const enrollment = sender._enrollment;
      const { deviceId, familyId } = message;

      if (!familyId || !deviceId) {
        sendTo(sender, {
          type: 'error',
          message: 'identity message requires familyId and deviceId',
        });
        return;
      }

      // Verify the claimed deviceId matches the enrolled token's deviceId
      // Prevents a token-holder from impersonating a sibling device
      if (deviceId !== enrollment.deviceId) {
        sendTo(sender, {
          type: 'error',
          message: 'deviceId does not match enrollment',
        });
        console.warn(`[identity] Device "${deviceId.slice(0, 12)}..." tried to impersonate enrollment device "${enrollment.deviceId.slice(0, 12)}..."`);
        return;
      }

      // Verify the claimed familyId matches enrollment
      if (familyId !== enrollment.familyId) {
        sendTo(sender, {
          type: 'error',
          message: 'familyId does not match enrollment',
        });
        return;
      }

      // ── Zombie socket cleanup ──────────────────────────────────────
      const oldSocket = deviceSockets.get(deviceId);
      if (oldSocket && oldSocket !== sender) {
        console.log(`[identity] Device "${deviceId.slice(0, 12)}..." re-identifying — closing old socket`);
        removeClient(oldSocket);
        try {
          oldSocket.close();
        } catch (_) {
          // already closed
        }
      }

      // Remove from old room if re-identifying
      const oldInfo = clientInfo.get(sender);
      if (oldInfo) {
        const oldRoom = familyRooms.get(oldInfo.familyId);
        if (oldRoom) oldRoom.delete(sender);
        const currentSocket = deviceSockets.get(oldInfo.deviceId);
        if (currentSocket === sender) {
          deviceSockets.delete(oldInfo.deviceId);
        }
      }

      // Join family room
      if (!familyRooms.has(familyId)) {
        familyRooms.set(familyId, new Set());
      }

      const room = familyRooms.get(familyId);

      // Enforce max clients per room
      if (room.size >= MAX_CLIENTS_PER_FAMILY) {
        sendTo(sender, {
          type: 'error',
          message: `Family room "${familyId}" is full (max ${MAX_CLIENTS_PER_FAMILY})`,
        });
        return;
      }

      room.add(sender);
      clientInfo.set(sender, { familyId, deviceId, relayToken: sender._relayToken });
      deviceSockets.set(deviceId, sender);

      console.log(`[identity] Device "${deviceId.slice(0, 12)}..." joined family "${familyId}" (${room.size} clients)`);

      sendTo(sender, {
        type: 'ack',
        message: 'Connected to relay',
        familyId,
        deviceId,
      });

      // Send stored update history to the client upon joining
      try {
        const { getAllUpdates } = require('./encrypted-store');
        const familyUpdates = getAllUpdates(familyId);
        let sentHistoryCount = 0;
        for (const [lId, updates] of Object.entries(familyUpdates)) {
          for (const update of updates) {
            sendTo(sender, {
              type: 'update',
              familyId,
              deviceId: 'stored-history',
              listId: lId,
              payload: update
            });
            sentHistoryCount++;
          }
        }
        if (sentHistoryCount > 0) {
          console.log(`[identity] Sent ${sentHistoryCount} historical updates to device "${deviceId.slice(0, 12)}..."`);
        }
      } catch (err) {
        console.warn(`[identity] Failed to load update history: ${err.message}`);
      }

      break;
    }

    case 'sync_request':
    case 'recovery_request':
    case 'recovery_response': {
      const senderInfo = clientInfo.get(sender);
      if (!sender._relayToken || !senderInfo || senderInfo.familyId !== message.familyId) {
        sendTo(sender, { type: 'error', message: 'Not authenticated for this family room' });
        return;
      }
      if (!checkRateLimit(sender._relayToken)) {
        sendTo(sender, { type: 'error', message: 'Rate limit exceeded (max 100 messages/min)' });
        return;
      }
      const { listId, payload } = message;
      if (typeof listId !== 'string' || !listId || !payload ||
          !['ciphertext', 'iv', 'tag'].every(field => typeof payload[field] === 'string' && payload[field])) {
        sendTo(sender, { type: 'error', message: 'Sync control message requires listId and encrypted payload' });
        return;
      }
      // The relay forwards opaque control ciphertext only. A completed recovery
      // snapshot and its nonce are authenticated by family devices inside it.
      // Bind sender identity to enrollment, never to the caller's deviceId.
      for (const client of familyRooms.get(senderInfo.familyId) || []) {
        if (client !== sender && client.readyState === client.OPEN) {
          sendTo(client, { type: message.type, familyId: senderInfo.familyId,
            deviceId: senderInfo.deviceId, listId, payload });
        }
      }
      break;
    }

    case 'update': {
      // Check authentication
      if (!sender._relayToken) {
        sendTo(sender, {
          type: 'error',
          message: 'Not authenticated. Send auth message first.',
        });
        return;
      }

      // Check rate limit
      if (!checkRateLimit(sender._relayToken)) {
        sendTo(sender, {
          type: 'error',
          message: 'Rate limit exceeded (max 100 messages/min)',
        });
        return;
      }

      const { familyId, deviceId, listId, payload } = message;

      if (!familyId || !listId || !payload) {
        sendTo(sender, {
          type: 'error',
          message: 'update message requires familyId, listId, and payload',
        });
        return;
      }

      // Verify sender is in the claimed family room
      const senderInfo = clientInfo.get(sender);
      if (!senderInfo || senderInfo.familyId !== familyId) {
        sendTo(sender, {
          type: 'error',
          message: 'Not authenticated for this family room',
        });
        return;
      }

      // Relay to all OTHER clients in the same family room
      const room = familyRooms.get(familyId);
      if (room) {
        let relayed = 0;
        room.forEach((client) => {
          if (client !== sender && client.readyState === client.OPEN) {
            sendTo(client, {
              type: 'update',
              familyId,
              deviceId,
              listId,
              payload,
            });
            relayed++;
          }
        });
        console.log(`[relay] Device "${deviceId.slice(0, 12)}..." → family "${familyId}" list "${listId}" → ${relayed} peers`);
      }

      // Save update to encrypted-store (100% zero-knowledge persistence)
      try {
        const { addUpdate } = require('./encrypted-store');
        addUpdate(familyId, listId, payload);
      } catch (err) {
        console.warn(`[ws-update] Failed to save update: ${err.message}`);
      }

      sendTo(sender, {
        type: 'ack',
        message: 'Update relayed',
      });
      break;
    }

    default:
      sendTo(sender, {
        type: 'error',
        message: `Unknown message type: ${message.type}`,
      });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendTo(ws, data) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.warn(`[error] Failed to send message: ${err.message}`);
    }
  }
}

// ─── Blind RSA Token Request Handler ────────────────────────────────────────

/**
 * Handle POST /relay/request-token.
 *
 * Authentication: extract relayToken from Authorization header.
 * Per-device rate limit: N tokens per hour (default: 10).
 * Body: { blindedMsg: "<base64>" }
 * Response: { blindSignature: "<base64>" }
 */
async function handleTokenRequest(req, res) {
  // 1. Authenticate via relayToken
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header. Expected: Bearer <relayToken>' }));
    return;
  }

  const relayToken = authHeader.slice('Bearer '.length).trim();
  const enrollment = enrolledDevices.get(relayToken);

  if (!enrollment) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid relay token' }));
    return;
  }

  // 2. Check token expiry (same sliding window as WebSocket auth)
  if (Date.now() > enrollment.expiresAt) {
    enrolledDevices.delete(relayToken);
    const familyTokens = familyDeviceTokens.get(enrollment.familyId);
    if (familyTokens) {
      familyTokens.delete(relayToken);
      if (familyTokens.size === 0) familyDeviceTokens.delete(enrollment.familyId);
    }
    persistState();
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Relay token has expired. Re-enroll to continue.' }));
    return;
  }

  // 3. Per-enrollment rate limit check.
  //
  // Keyed on relayToken, NOT enrollment.deviceId (audit H11). /enroll stores
  // deviceId verbatim from the request body — nothing signs it, since the
  // invite's Ed25519 signature covers the *inviter's* deviceId, never the
  // enrollee's — and a deviceId is public inside a family (it is the base64
  // signing key embedded in every invite). Keying on it therefore let any
  // family member enroll while claiming a peer's deviceId and spend that
  // peer's hourly budget, 429ing a victim who had issued nothing. relayToken
  // is 32 CSPRNG bytes minted server-side and is not attacker-choosable.
  //
  // This does not raise the issuance ceiling in any meaningful way: a fresh
  // bucket still costs a fresh enrollment, which is what MAX_DEVICES_PER_FAMILY
  // and the /enroll limiter bound.
  if (!checkTokenRateLimit(relayToken)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `Token rate limit exceeded. Max ${TOKEN_RATE_LIMIT} tokens per hour per device.`,
    }));
    return;
  }

  // 4. Parse body (streaming cap — see lib/collect-body.js)
  const body = await collectBody(req, 4096);
  if (body === null) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request body too large (max 4096 bytes)' }));
    return;
  }

  {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { blindedMsg } = parsed;
    if (!blindedMsg || typeof blindedMsg !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'blindedMsg field is required and must be a base64 string' }));
      return;
    }

    // 5. Decode blinded message and blind-sign
    try {
      await ensureIssuerLoaded();

      const blindMsgBytes = Buffer.from(blindedMsg, 'base64');
      const blindSignature = await _blindRsaSuite.blindSign(_issuerPrivateKey, new Uint8Array(blindMsgBytes));

      // 6. Return the blind signature (base64-encoded)
      const blindSigBase64 = Buffer.from(blindSignature).toString('base64');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ blindSignature: blindSigBase64 }));
    } catch (err) {
      console.warn('[token] Blind signing error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to sign token' }));
    }
  }
}

// ─── Start ────────────────────────────────═══════════════════════════════════

// Load persisted state from disk (enrollments, invite signatures)
loadStateFromDisk();

// Voice-assistant public key is loaded lazily on first request. The relay
// never generates or holds the assistant private key (see getAssistantPublicKey
// and assistant-keygen.js); if ASSISTANT_INTEGRATION is on but no public key is
// provisioned, the public-key endpoint fails closed.

// Load the used tokens store (non-blocking)
usedTokensStore.loadOnStartup().catch((err) => {
  console.warn(`[used-tokens] Startup error: ${err.message}`);
});

// Periodic cleanup of token rate limiters (every 2 hours)
setInterval(cleanTokenRateLimiters, 2 * 60 * 60 * 1000);

server.listen(RELAY_PORT, () => {
  const protocol = TLS_CERT_PATH && TLS_KEY_PATH ? 'wss' : 'ws';
  const httpProtocol = TLS_CERT_PATH && TLS_KEY_PATH ? 'https' : 'http';
  console.log(`\n╔══════════════════════════════════════════════════════════════╗
  ║      GroceryApp Relay Server v2                             ║
  ║      Listening on port ${String(RELAY_PORT).padEnd(5)}                               ║
  ║      Identity-aware WebSocket relay for Yjs sync            ║
  ╚══════════════════════════════════════════════════════════════╝

  WebSocket: ${protocol}://localhost:${RELAY_PORT}
  Health:    ${httpProtocol}://localhost:${RELAY_PORT}/health
  Stats:     ${httpProtocol}://localhost:${RELAY_PORT}/stats
  Enroll:    POST ${httpProtocol}://localhost:${RELAY_PORT}/enroll  { deviceToken, familyInviteToken }

  Rate limit:       ${RATE_LIMIT_MESSAGES} messages/min per device
  Max families:     ${MAX_FAMILIES}
  Max devices/family: ${MAX_DEVICES_PER_FAMILY}
  Max clients/family: ${MAX_CLIENTS_PER_FAMILY}
  Token TTL:        ${Math.round(TOKEN_TTL_MS / 86400000)} days
  Auth via:         message (type: 'auth', relayToken: '...')
  TLS:              ${TLS_CERT_PATH && TLS_KEY_PATH ? 'enabled' : 'disabled (use reverse proxy)'}
  `);

    // Periodic cleanup of expired tokens (every hour)
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [token, enrollment] of enrolledDevices) {
        if (now > enrollment.expiresAt) {
          enrolledDevices.delete(token);
          const familyTokens = familyDeviceTokens.get(enrollment.familyId);
          if (familyTokens) {
            familyTokens.delete(token);
            if (familyTokens.size === 0) familyDeviceTokens.delete(enrollment.familyId);
          }
          cleaned++;
        }
      }
      // Prune used-invite entries whose invite expiry has passed (an expired
      // invite is rejected by the expiry check before the replay set is
      // consulted, so the entry is no longer needed).
      let prunedInvites = 0;
      for (const [inviteKey, inviteExpiresAt] of usedInviteSignatures) {
        if (typeof inviteExpiresAt !== 'number' || now > inviteExpiresAt) {
          usedInviteSignatures.delete(inviteKey);
          prunedInvites++;
        }
      }
      if (cleaned > 0 || prunedInvites > 0) {
        console.log(`[cleanup] Removed ${cleaned} expired token(s) and ${prunedInvites} expired invite(s)`);
        persistState();
      }
      // Pairing sessions past their TTL. Expiry is already enforced on every
      // read (findPairingSession); this sweep only keeps the map from holding
      // abandoned sessions until restart.
      const prunedSessions = cleanOauthSessions();
      if (prunedSessions > 0) {
        console.log(`[cleanup] Removed ${prunedSessions} expired pairing session(s)`);
      }
      // Retention: age out stored encrypted updates (ciphertext-only, but
      // don't keep them forever). Default 30 days, override via UPDATE_TTL_MS.
      try {
        const { cleanupExpiredUpdates } = require('./encrypted-store');
        const updateTtlMs = parseInt(process.env.UPDATE_TTL_MS || '2592000000', 10);
        const removedUpdates = cleanupExpiredUpdates(updateTtlMs);
        if (removedUpdates > 0) {
          console.log(`[cleanup] Removed ${removedUpdates} encrypted update(s) past retention (${Math.round(updateTtlMs / 86400000)}d)`);
        }
      } catch (err) {
        console.error('[cleanup] Encrypted-update retention sweep failed:', err.message);
      }
    }, 60 * 60 * 1000);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function gracefulShutdown() {
  console.log('[shutdown] Flushing state...');
  if (_saveTimeout) { clearTimeout(_saveTimeout); persistState(); }
  usedTokensStore.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start the pool HTTP server on a separate port
if (POOL_PORT !== RELAY_PORT) {
  poolServer.listen(POOL_PORT, () => {
    console.log(`  Pool API:  http://localhost:${POOL_PORT}/api/pool/contribute`);
  });
} else {
  // When ports are the same, pool is served on the main server (no isolation needed)
  console.log(`  Pool API:  same server (POOL_PORT=${POOL_PORT})`);
}

function getAuthorizeHtml(pairingCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Voice Assistant | GroceryApp</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #8a2be2;
      --secondary: #4b0082;
      --glow: #00ffff;
      --bg: #0b0813;
      --card-bg: rgba(255, 255, 255, 0.03);
      --card-border: rgba(255, 255, 255, 0.08);
      --text: #f3f0ff;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Outfit', sans-serif;
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }
    
    /* Background animated blobs */
    .blob {
      position: absolute;
      border-radius: 50%;
      filter: blur(80px);
      z-index: 1;
      opacity: 0.15;
      animation: float 20s infinite alternate ease-in-out;
    }
    .blob-1 {
      width: 400px;
      height: 400px;
      background: var(--primary);
      top: -10%;
      left: -10%;
    }
    .blob-2 {
      width: 500px;
      height: 500px;
      background: var(--glow);
      bottom: -10%;
      right: -10%;
      animation-delay: -10s;
    }
    
    @keyframes float {
      0% { transform: translate(0, 0) scale(1); }
      100% { transform: translate(50px, 50px) scale(1.1); }
    }
    
    .container {
      z-index: 10;
      width: 100%;
      max-width: 480px;
      padding: 20px;
    }
    
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 40px 30px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1);
      text-align: center;
      transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .logo {
      font-weight: 800;
      font-size: 28px;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #fff 0%, #a855f7 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 24px;
    }
    
    .title {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    
    .description {
      font-size: 14px;
      color: #9ca3af;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    
    .code-container {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 32px;
      position: relative;
      overflow: hidden;
    }
    
    .code {
      font-family: monospace;
      font-size: 48px;
      font-weight: 800;
      letter-spacing: 8px;
      color: #fff;
      text-shadow: 0 0 20px rgba(168, 85, 247, 0.4);
    }
    
    .status-container {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      font-size: 14px;
      color: #a78bfa;
    }
    
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(167, 139, 250, 0.2);
      border-top-color: #a78bfa;
      border-radius: 50%;
      animation: spin 1s infinite linear;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    /* Success states */
    .success-card {
      border-color: rgba(34, 197, 94, 0.3);
      box-shadow: 0 20px 40px rgba(34, 197, 94, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    
    .success {
      color: #22c55e !important;
    }
  </style>
</head>
<body>
  <div class="blob blob-1"></div>
  <div class="blob blob-2"></div>
  
  <div class="container">
    <div class="card" id="card">
      <div class="logo">GroceryApp</div>
      <h1 class="title">Link Voice Assistant</h1>
      <p class="description">
        Open the GroceryApp on your phone, go to <strong>Settings</strong> &rarr; <strong>Link Voice Assistant</strong>, and enter the 6-digit code below to securely link your account.
      </p>
      
      <div class="code-container">
        <div class="code">${pairingCode}</div>
      </div>
      
      <div class="status-container" id="status-box">
        <div class="spinner" id="status-icon"></div>
        <span id="status">Waiting for connection...</span>
      </div>
    </div>
  </div>
  
  <script>
    const pairingCode = "${pairingCode}";
    const poll = setInterval(async () => {
      try {
        const res = await fetch(\`/oauth/status?pairingCode=\` + pairingCode);
        if (res.ok) {
          const data = await res.json();
          if (data.linked && data.redirectUri) {
            clearInterval(poll);
            document.getElementById('status').innerText = 'Successfully Linked! Redirecting...';
            document.getElementById('status').classList.add('success');
            document.getElementById('status-icon').style.display = 'none';
            document.getElementById('card').classList.add('success-card');
            setTimeout(() => {
              window.location.href = data.redirectUri;
            }, 1500);
          }
        }
      } catch (e) {
        console.error(e);
      }
    }, 1500);
  </script>
</body>
</html>`;
}