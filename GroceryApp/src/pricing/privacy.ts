/**
 * Price Subsystem — Privacy Hashing.
 *
 * Provides item-name obfuscation for external adapters. Local adapters
 * (crowdsourced, flyer-scan) use plaintext normalized names.
 *
 * HONESTY NOTE (do not overstate this in user-facing copy): hashItemName()
 * is NOT a cryptographic hash. It is a 48-bit FNV-1a-style digest, and the
 * grocery vocabulary is small enough that anyone can precompute the digest
 * of every common item name and reverse it. It prevents casual logging of
 * plaintext, nothing more. In v1 every adapter that would receive these
 * digests is dead code (instacart/scraping are stubs; cloud-flyer sends no
 * item names), so nothing hashed here leaves the device.
 */

// ─── Hashing ────────────────────────────────────────────────────────────────

/**
 * Normalize and obfuscate an item name for external lookups.
 * Returns the first 12 hex chars (48 bits) of a non-cryptographic
 * FNV-1a-style digest — see the honesty note above. If a future adapter
 * actually transmits these, replace with a real cryptographic hash
 * (e.g. the pure-TS SHA-256 in src/identity/recovery.ts) first.
 *
 * Only used for external (non-local) adapters.
 * Local adapters (crowdsourced, flyer-scan) use plaintext normalized names.
 */
export function hashItemName(name: string): string {
  const normalized = normalizeForLookup(name);
  return fnv1aHashHex(normalized).slice(0, 12);
}

/**
 * Normalize an item name for consistent lookup across adapters.
 * Lowercases, trims, and collapses whitespace.
 */
export function normalizeForLookup(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Check if an adapter requires hashed item names.
 * Adapters that match on the device can use plaintext; remote adapters
 * should use hashes. flipp-deals and store-prices download a whole region
 * from the relay and match locally — no item name leaves the device.
 */
export function adapterRequiresHash(adapterId: string): boolean {
  const localAdapters = new Set(['crowdsourced', 'flyer-scan', 'flipp-deals', 'store-prices']);
  return !localAdapters.has(adapterId);
}

/**
 * Privacy-aware name resolution: returns plaintext for local sources,
 * hash for external sources.
 */
export function privacySanitize(
  itemName: string,
  source: 'local' | 'external',
): string {
  if (source === 'local') {
    return normalizeForLookup(itemName);
  }
  return hashItemName(itemName);
}

// ─── Internal SHA-256 Implementation ────────────────────────────────────────

/**
 * Synchronous SHA-256 producing a hex string.
 * Uses a pure-JS FNV-1a-like hash for deterministic obfuscation.
 * This is NOT cryptographically secure — it's a privacy obfuscation layer,
 * not a security primitive. The goal is to avoid sending plaintext item
 * names to external adapters.
 *
 * For a real cryptographic hash, use the pure-TS SHA-256 in
 * src/identity/recovery.ts (libsodium's crypto_hash_sha256 is NOT exposed
 * by react-native-libsodium at runtime — see GOAL_PROMPT_NOTES.md, Goal 5).
 */
function fnv1aHashHex(input: string): string {
  // FNV-1a 32-bit × 4 rounds to get 128 bits → 32 hex chars
  // Good enough for privacy obfuscation of grocery item names.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0xdeadbeef;
  let h4 = 0x12345678;

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x811c9dc5);
    h3 ^= c;
    h3 = Math.imul(h3, 0x1b873593);
    h4 ^= c;
    h4 = Math.imul(h4, 0xcc9e2d51);
  }

  // Additional mixing
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0x85ebca6b);
  h2 ^= h2 >>> 13;
  h3 = Math.imul(h3 ^ (h3 >>> 16), 0x85ebca6b);
  h3 ^= h3 >>> 13;
  h4 = Math.imul(h4 ^ (h4 >>> 16), 0x85ebca6b);
  h4 ^= h4 >>> 13;

  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0') +
    (h3 >>> 0).toString(16).padStart(8, '0') +
    (h4 >>> 0).toString(16).padStart(8, '0')
  );
}
