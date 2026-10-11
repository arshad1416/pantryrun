/**
 * Price Subsystem — Anonymous Contribution Pipeline.
 *
 * Phase C (Stage 3): Anonymized flyer price contributions to the shared pool.
 *
 * PRIVACY CONTRACT:
 *   - Contributed payloads NEVER contain deviceId, familyId, GPS, IP,
 *     or fine timestamps (epoch ms).
 *   - `validFrom` is coarsened to an ISO week string to prevent
 *     fingerprinting via scan timing.
 *   - `storeId` is composed as "chain:region" by default; exact branch
 *     is only included if the user explicitly opts in.
 *   - ZERO network I/O when `contributeEnabled` is false.
 */

import type { ScannedFlyerPrice, ContributedFlyerPrice } from './flyer-types';
import { getSettings } from '../config/settings';
import { getContributionToken, clearContributionTokenCache } from './tokens';
import { poolStoreId } from './cloud-flyer';
import { normalizeFsa } from './live-prices';

// ─── Settings Key ────────────────────────────────────────────────────────────

/**
 * Derive the HTTP relay URL from settings.
 *
 * If `poolUrl` is set (community/managed pool), use it directly.
 * Otherwise, derive from the WebSocket relay URL (self-hosted mode).
 */
function getHttpRelayUrl(): string {
  const { relayUrl, relayPort, poolUrl } = getSettings();

  // Pool URL explicitly configured — use it directly (transport isolation)
  if (poolUrl) {
    return poolUrl;
  }

  // Fallback: derive from the WebSocket relay URL
  const httpUrl = relayUrl
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:');
  let base: string;
  try {
    const parsed = new URL(httpUrl);
    if (parsed.port) {
      base = httpUrl;
    } else {
      base = `${httpUrl}:${relayPort}`;
    }
  } catch {
    base = `${httpUrl}:${relayPort}`;
  }
  return base;
}

// ─── ISO Week Helper ────────────────────────────────────────────────────────

/**
 * Convert a Unix timestamp (epoch ms) to an ISO week string (e.g. "2026-W22").
 *
 * Coarsening timestamps to week granularity prevents fingerprinting via
 * precise scan timing while preserving the useful temporal context.
 */
export function epochMsToIsoWeek(ms: number): string {
  const d = new Date(ms);
  // Copy date so we don't mutate the original
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Set to nearest Thursday (ISO week rule: week containing Thursday)
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  // Compute week number
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const diffDays = Math.floor(
    (date.getTime() - jan1.getTime()) / 86400000,
  );
  const week = Math.ceil((diffDays + jan1.getUTCDay() + 1) / 7);
  // Pad to two digits
  const weekStr = String(week).padStart(2, '0');
  return `${year}-W${weekStr}`;
}

// ─── Transform ──────────────────────────────────────────────────────────────

/**
 * Transform a ScannedFlyerPrice into a ContributedFlyerPrice.
 *
 * Strips all §3-forbidden fields (deviceId, familyId, GPS, IP, scannedAt,
 * confidence, storeId, storeName, quantity) and coarsens `validFrom` to an
 * ISO week string.
 *
 * @param scanned - The scanned price from the flyer pipeline
 * @param storeChain - Chain identifier (e.g. "walmart", "costco")
 * @param storeRegion - Region identifier (e.g. "toronto", "vancouver")
 * @returns An anonymized contributed price payload
 */
export function toContributedPrice(
  scanned: ScannedFlyerPrice,
  storeChain: string,
  storeRegion: string,
): ContributedFlyerPrice {
  const { contributeStoreGranularity } = getSettings();
  const includeBranch = contributeStoreGranularity === 'branch';

  // Compose storeId dynamically based on granularity
  const storeId = includeBranch
    ? `${storeChain}:${scanned.storeId}`
    : `${storeChain}:${storeRegion}`;

  // Coarsen validFrom to ISO week
  const validFromWeek = epochMsToIsoWeek(scanned.scannedAt);

  // Derive flyerWeek from validTo if available, otherwise from scannedAt
  const flyerWeek = scanned.validTo
    ? epochMsToIsoWeek(scanned.validTo)
    : validFromWeek;

  // Extract itemNormalized from the scanned item (strip for matching)
  const itemNormalized = scanned.itemName.toLowerCase().trim();

  // Derive size from quantity + unit for contributed payload
  const size = scanned.quantity > 1
    ? `${scanned.quantity}${scanned.unit}`
    : scanned.unit;

  // Compute unitPrice (price / quantity)
  const unitPrice = scanned.quantity > 0
    ? parseFloat((scanned.price / scanned.quantity).toFixed(4))
    : scanned.price;

  // Extract regularPrice from saleInfo if available
  const regularPrice = scanned.saleInfo?.regularPrice;

  return {
    storeId,
    itemName: scanned.itemName,
    itemNormalized,
    brand: undefined, // not available from scanned price
    size,
    unit: scanned.unit,
    price: scanned.price,
    regularPrice,
    unitPrice,
    validFromWeek,
    validTo: scanned.validTo ?? 0,
    flyerWeek,
  };
}

// ─── Batching & Rate Limiting ───────────────────────────────────────────────

/**
 * Minimum interval between batch submissions (milliseconds).
 * Max 1 batch per 60 seconds.
 */
const BATCH_INTERVAL_MS = 60_000;

/**
 * Randomized delay range before the first flush (1–5 minutes).
 */
const FLUSH_DELAY_MIN_MS = 60_000;
const FLUSH_DELAY_MAX_MS = 300_000;

/** Module-level buffer of contributed prices waiting to be flushed. */
let pendingBuffer: ContributedFlyerPrice[] = [];

/** Timer handle for scheduled flushes. */
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Timestamp of the last batch submission (for rate limiting). */
let lastBatchTime = 0;

/**
 * Clear the pending buffer and cancel any scheduled flush.
 * Used for testing cleanup.
 */
export function resetContributionBuffer(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingBuffer = [];
  lastBatchTime = 0;
}

/**
 * Get the current pending buffer size (for testing).
 */
export function getPendingBufferSize(): number {
  return pendingBuffer.length;
}

/**
 * Get the module-level last batch time (for testing).
 */
export function getLastBatchTime(): number {
  return lastBatchTime;
}

// ─── Submission ──────────────────────────────────────────────────────────────

/**
 * Submit a single contributed price to the server.
 *
 * Attaches a blind-signed contribution token via Authorization header.
 * Retries once with a fresh token on 401/403 response.
 *
 * Server expects a single-object POST to /api/pool/contribute.
 */
async function sendContribution(
  price: ContributedFlyerPrice,
): Promise<boolean> {
  const baseUrl = getHttpRelayUrl();
  const url = `${baseUrl}/api/pool/contribute`;

  // Obtain a contribution token (null = self-host mode, no token needed)
  const token = await getContributionToken();

  async function doPost(authToken: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(price),
      signal: AbortSignal.timeout(10_000),
    });
  }

  try {
    const response = await doPost(token);

    // If token was rejected, try once with a fresh token
    if ((response.status === 401 || response.status === 403) && token) {
      clearContributionTokenCache();
      const newToken = await getContributionToken();
      if (newToken) {
        const retryResponse = await doPost(newToken);
        return retryResponse.ok;
      }
      return false;
    }

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Flush the pending buffer: send all buffered contributions as individual
 * POST requests within a timed burst.
 *
 * Respects the 60-second rate limit between batches.
 */
async function flushBuffer(): Promise<void> {
  if (pendingBuffer.length === 0) return;

  // Rate limit check
  const now = Date.now();
  const timeSinceLastBatch = now - lastBatchTime;
  if (timeSinceLastBatch < BATCH_INTERVAL_MS) {
    // Re-schedule flush for when the rate limit expires
    const delay = BATCH_INTERVAL_MS - timeSinceLastBatch;
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushBuffer();
      }, delay);
    }
    return;
  }

  // Take a snapshot of the buffer and clear it
  const batch = pendingBuffer.slice();
  pendingBuffer = [];
  lastBatchTime = Date.now();

  // Send each price as an individual POST in a timed burst
  // We fire all requests concurrently so they arrive in a close window
  const results = await Promise.allSettled(
    batch.map((price) => sendContribution(price)),
  );

  // Log failures (non-blocking)
  const failures = results.filter(
    (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value),
  ).length;
  if (failures > 0) {
    console.warn(
      `[contribute] ${failures}/${batch.length} contributions failed to send`,
    );
  }
}

/**
 * Schedule a flush with a randomized delay (1-5 minutes).
 */
function scheduleFlush(): void {
  if (flushTimer !== null) return; // Already scheduled

  const delay =
    FLUSH_DELAY_MIN_MS +
    Math.random() * (FLUSH_DELAY_MAX_MS - FLUSH_DELAY_MIN_MS);

  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBuffer();
  }, delay);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Submit scanned prices to the anonymous contribution pool.
 *
 * GATE: If `contributeEnabled` is false, this function returns immediately
 * and performs ZERO network I/O.
 *
 * Transforms scanned prices to contributed prices, buffers them, and
 * schedules a delayed flush (1-5 min randomized) to the server.
 * Each price is sent as an individual POST within a timed batch.
 * Rate-limited to a maximum of 1 batch per 60 seconds.
 *
 * @param prices - Scanned flyer prices to contribute
 */
export async function submitContributions(
  prices: ScannedFlyerPrice[],
): Promise<void> {
  // Privacy gate: zero network I/O when disabled
  const { contributeEnabled, flippFsa } = getSettings();
  if (!contributeEnabled) return;

  // File each price under the same pool store id CloudFlyerAdapter looks up:
  // the app's store id as the chain, the user's FSA as the region
  // ("no-frills:M5V"). No region set: nothing could ever look these up, and
  // a region-less pool id would mix regions, so contribute nothing.
  const region = normalizeFsa(flippFsa);
  if (!region) return;

  // Transform and buffer
  for (const price of prices) {
    if (!poolStoreId(price.storeId, region)) continue;
    const contributed = toContributedPrice(price, price.storeId.trim(), region);
    pendingBuffer.push(contributed);
  }

  // Schedule flush with randomized delay
  scheduleFlush();
}
