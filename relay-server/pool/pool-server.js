/**
 * Pool Server — HTTP Handler for Pool Endpoints.
 *
 * Routes:
 *  - POST /api/pool/contribute — accepts JSON body, validates, stores via aggregator
 *  - GET /api/pool/prices?storeId=X — returns currently-valid pooled prices for store
 *
 * Token-gated via RFC 9474 Blind RSA tokens:
 *   Authorization: Bearer v2.<base64(tokenBytes)>
 *   where tokenBytes = signature (256 bytes for 2048-bit RSA) || nonce (32 bytes)
 *
 * The pool verifies tokens using the ISSUER_PUBLIC_KEY (RSA public key PEM).
 * If ISSUER_PUBLIC_KEY is not set, the pool returns 500 (fail closed).
 * There is NO open mode — self-host users must either configure the key or
 * use a separate deployment without the pool.
 *
 * Single-use enforcement is handled by a shared UsedTokensStore persisted to disk.
 *
 * All responses include CORS headers. Returns proper HTTP status codes.
 */

const { aggregatePriceReports } = require('./aggregator');
const { collectBody } = require('../lib/collect-body');

// ─── Token Configuration ────────────────────────────────────────────────────

/**
 * ISSUER_PUBLIC_KEY from environment (PEM string or path to PEM file).
 * If neither is set, the pool fails closed (returns 500).
 */
const ISSUER_PUBLIC_KEY_PEM = process.env.ISSUER_PUBLIC_KEY || null;
const ISSUER_PUBLIC_KEY_PATH = process.env.ISSUER_PUBLIC_KEY_PATH || null;

// Lazy-loaded BlindRSA suite and public key
let _blindRsaSuite = null;
let _publicKey = null;

/**
 * Load (or reload) the BlindRSA suite and issuer public key.
 * Must be called before verifying any token.
 */
async function ensureVerifierLoaded() {
  if (_blindRsaSuite && _publicKey) return;

  const fs = require('fs');
  const { BlindRSA, Params } = await import('@cloudflare/blindrsa-ts');

  // Create the suite using RSABSSA-SHA384-PSS-Randomized (RFC 9474 standard)
  const suite = new BlindRSA(Params.RSABSSA_SHA384_PSS_Randomized);

  // Load public key PEM
  let pemData = ISSUER_PUBLIC_KEY_PEM;
  if (!pemData && ISSUER_PUBLIC_KEY_PATH) {
    pemData = fs.readFileSync(ISSUER_PUBLIC_KEY_PATH, 'utf-8');
  }

  if (!pemData) {
    throw new Error('ISSUER_PUBLIC_KEY not configured. Set ISSUER_PUBLIC_KEY env var or ISSUER_PUBLIC_KEY_PATH.');
  }

  // Parse PEM to DER (raw binary)
  const base64 = pemData
    .replace(/-----BEGIN [\w ]+-----/g, '')
    .replace(/-----END [\w ]+-----/g, '')
    .replace(/\s/g, '');
  const binary = Buffer.from(base64, 'base64');
  const derBytes = new Uint8Array(binary);
  const publicKey = await crypto.subtle.importKey(
    'spki',
    derBytes.buffer,
    { name: 'RSA-PSS', hash: 'SHA-384' },
    false,
    ['verify']
  );

  _blindRsaSuite = suite;
  _publicKey = publicKey;
}

// ─── Token Parsing ──────────────────────────────────────────────────────────

/**
 * Parse a v2 Blind RSA token from the Authorization header.
 * Token format: "v2.<base64(tokenBytes)>"
 * where tokenBytes = signature (256 bytes for 2048-bit RSA) || nonce (32 bytes)
 *
 * @param {string} tokenStr
 * @returns {{ valid: boolean, error?: string, signature?: Uint8Array, nonce?: Uint8Array }}
 */
function parseToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') {
    return { valid: false, error: 'Token is required' };
  }

  const parts = tokenStr.split('.');
  if (parts.length !== 2) {
    return { valid: false, error: 'Malformed token: expected format v2.<base64>' };
  }

  const [version, encoded] = parts;
  if (version !== 'v2') {
    return { valid: false, error: `Unknown token version: ${version}` };
  }

  let tokenBytes;
  try {
    tokenBytes = Buffer.from(encoded, 'base64');
  } catch {
    return { valid: false, error: 'Invalid base64 encoding' };
  }

  // Token format: signature (256 bytes for 2048-bit RSA) | nonce (32 bytes)
  if (tokenBytes.length !== 288) {
    return { valid: false, error: `Invalid token length: expected 288 bytes, got ${tokenBytes.length}` };
  }

  // Reject non-canonical transport encodings. Buffer.from(_, 'base64') is
  // lenient: base64url (`-_` for `+/`) and injected whitespace/newlines all
  // decode to the SAME bytes while producing different strings. That is
  // harmless now that single-use is keyed on the signed nonce below, but it
  // costs one re-encode to make the wire form 1:1 with the bytes, so a future
  // string-keyed lookup can never silently reintroduce the double-spend.
  // 288 bytes is an exact multiple of 3, so the canonical form has no padding
  // and no trailing-bit slack — this comparison is exact.
  if (tokenBytes.toString('base64') !== encoded) {
    return { valid: false, error: 'Non-canonical token encoding' };
  }

  const signature = new Uint8Array(tokenBytes.slice(0, 256));
  const nonce = new Uint8Array(tokenBytes.slice(256, 288));

  return { valid: true, signature, nonce, tokenStr };
}

/**
 * The used-tokens store instance for single-use enforcement.
 * Set externally by server.js (shared instance).
 */
let usedTokensStore = null;

/**
 * Set the shared UsedTokensStore instance.
 * @param {object} store
 */
function setUsedTokensStore(store) {
  usedTokensStore = store;
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

const FLYER_WEEK_REGEX = /^\d{4}-W\d{2}$/;

/**
 * Validate the contribution request body.
 * @param {object} body
 * @returns {{ valid: boolean, error?: string }}
 */
function validateContribution(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const { storeId, itemName, price, flyerWeek, validTo } = body;

  if (!storeId || typeof storeId !== 'string') {
    return { valid: false, error: 'storeId is required and must be a string' };
  }

  if (!itemName || typeof itemName !== 'string') {
    return { valid: false, error: 'itemName is required and must be a string' };
  }

  if (typeof price !== 'number' || isNaN(price)) {
    return { valid: false, error: 'price is required and must be a number' };
  }

  if (price < 0.01 || price > 999.99) {
    return { valid: false, error: 'price must be between $0.01 and $999.99' };
  }

  if (!flyerWeek || typeof flyerWeek !== 'string' || !FLYER_WEEK_REGEX.test(flyerWeek)) {
    return { valid: false, error: 'flyerWeek is required and must match format YYYY-WXX (e.g. 2026-W22)' };
  }

  if (!validTo || typeof validTo !== 'number' || isNaN(validTo)) {
    return { valid: false, error: 'validTo is required and must be a number (epoch ms)' };
  }

  return { valid: true };
}

// ─── Request Handler ─────────────────────────────────────────────────────────

/**
 * Handle pool-related HTTP requests.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('./store').PoolStore} store - PoolStore instance
 */
function handlePoolRequest(req, res, store) {
  // CORS headers (same as main server)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  // POST /api/pool/contribute
  if (url.pathname === '/api/pool/contribute' && req.method === 'POST') {
    handleContribute(req, res, store);
    return;
  }

  // GET /api/pool/prices?storeId=X
  if (url.pathname === '/api/pool/prices' && req.method === 'GET') {
    const storeId = url.searchParams.get('storeId');
    if (!storeId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'storeId query parameter is required' }));
      return;
    }

    const aggregates = store.getAggregates(storeId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ storeId, prices: aggregates }));
    return;
  }

  // Unknown pool endpoint
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

/** Max contribution body size (bytes). */
const MAX_CONTRIBUTE_BODY_BYTES = 4096;

/**
 * Handle a contribution POST request with Blind RSA token verification.
 */
async function handleContribute(req, res, store) {
  // ── Token Verification (fail closed) ──────────────────────────────────
  try {
    await ensureVerifierLoaded();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Pool not configured: ' + err.message }));
    return;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header. Expected: Bearer <token>' }));
    return;
  }

  const tokenStr = authHeader.slice('Bearer '.length).trim();
  const parsed = parseToken(tokenStr);

  if (!parsed.valid) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: parsed.error }));
    return;
  }

  // Verify Blind RSA signature: verify(publicKey, signature, nonce)
  let validSig;
  try {
    validSig = await _blindRsaSuite.verify(_publicKey, parsed.signature, parsed.nonce);
  } catch (err) {
    console.warn('[pool] Token verification error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Token verification failed' }));
    return;
  }

  if (!validSig) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid token signature' }));
    return;
  }

  // Single-use enforcement (replay protection).
  //
  // Keyed on the SIGNED VALUE (the 32-byte nonce), never on the transport
  // string: the signature is verified over the decoded bytes, so any string
  // that decodes to those bytes is the same token and must consume the same
  // spent-set slot. Keying on tokenStr gave one signed payload unlimited
  // distinct keys — i.e. unlimited replays (audit C1).
  //
  // MIGRATION — the legacy arm below is transitional. Entries already on disk
  // were written as hashToken("v2.<base64>"); the nonce key hashes something
  // else entirely, so those never collide and every already-spent token would
  // become spendable exactly once the moment this deploys. isUsed(tokenStr)
  // closes that window without wiping the store. Legacy entries were always
  // written from a canonical string, so the canonicality check in parseToken
  // does not stop this arm from matching a genuine legacy replay.
  // The arm can be dropped once every token issued before this deploy is
  // known to be spent or abandoned — note the v2 format carries no expiry, so
  // that is an operator judgement call, not a date the code can compute.
  if (usedTokensStore) {
    const nonceKey = Buffer.from(parsed.nonce).toString('hex');
    if (usedTokensStore.isUsed(tokenStr) || !usedTokensStore.checkAndMark(nonceKey)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token has already been used' }));
      return;
    }
  }

  // ── Body Parsing & Validation ────────────────────────────────────────
  // Shared streaming-capped collector (lib/collect-body.js): rejects while
  // bytes arrive instead of buffering the whole body first.
  const body = await collectBody(req, MAX_CONTRIBUTE_BODY_BYTES);
  if (body === null) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request body too large (max 4096 bytes)' }));
    return;
  }

  let bodyParsed;
  try {
    bodyParsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const validation = validateContribution(bodyParsed);
  if (!validation.valid) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: validation.error }));
    return;
  }

  const { storeId, itemName, price, flyerWeek, validTo } = bodyParsed;
  const normalizedName = itemName.toLowerCase().trim();
  const key = `${storeId}:${normalizedName}:${flyerWeek}`;

  store.addReport(key, price, validTo, { storeId, itemName: normalizedName, flyerWeek });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', key }));
}

module.exports = {
  handlePoolRequest,
  setUsedTokensStore,
};
