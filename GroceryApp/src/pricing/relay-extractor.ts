/**
 * Price Subsystem — Relay Flyer Extractor.
 *
 * Implements the FlyerExtractor interface by sending images to the
 * relay server's POST /api/extract/flyer endpoint.
 *
 * ⚠️  PRIVACY NOTICE — THIS CHANNEL IS NOT ZERO-KNOWLEDGE  ⚠️
 * Unlike the core E2E-encrypted sync channel, the flyer extraction
 * pipeline sends raw base64-encoded images to the relay server in
 * plaintext (over TLS). The relay operator CAN see the contents of
 * flyer images, including store names, product names, and pricing.
 *
 * The zero-knowledge guarantee (AC-11) applies only to the grocery
 * list sync path (Yjs + libsodium). The flyer extraction pipeline
 * explicitly does NOT carry that guarantee.
 *
 * Future improvements for true zero-knowledge extraction:
 *   - Client-side on-device OCR (CoreML / MLKit)
 *   - Client-side image redaction before upload
 *   - Fully homomorphic encryption (not practical for images yet)
 *
 * Never throws — returns empty array on any failure so the pipeline
 * continues without crashing.
 */

import type { ScannedFlyerPrice, FlyerExtractor } from './flyer-types';
import type { SaleInfo } from './types';
import { getRelayToken } from '../identity/enroll';
import { getRelayHttpBaseUrl } from './relay-client';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExtractResponsePrice {
  itemName: string;
  price: number;
  unit: string;
  quantity: number;
  confidence: number;
  saleInfo: {
    isOnSale: boolean;
    salePrice: number;
    regularPrice: number | null;
    saleEndDate: number | null;
  } | null;
}

interface ExtractResponse {
  prices: ExtractResponsePrice[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a SaleInfo from extract response sale data.
 */
function buildSaleInfo(
  sale: { isOnSale: boolean; salePrice: number; regularPrice: number | null; saleEndDate: number | null } | null,
): SaleInfo | null {
  if (!sale || !sale.isOnSale) return null;

  const salePrice = sale.salePrice;
  const regularPrice = sale.regularPrice ?? salePrice;
  const unitPriceVsRegular = regularPrice - salePrice;
  const savingsPercent = regularPrice > 0
    ? Math.round(((regularPrice - salePrice) / regularPrice) * 10000) / 100
    : 0;

  return {
    isOnSale: true,
    salePrice,
    regularPrice,
    saleEndDate: sale.saleEndDate ?? null,
    unitPriceVsRegular,
    savingsPercent,
  };
}

/**
 * Read a file and return it as a base64 data URI.
 * Handles file:// URIs by fetching them.
 */
async function fileUriToBase64(uri: string): Promise<string> {
  // If it's already a data URI, return as-is
  if (uri.startsWith('data:')) {
    return uri;
  }

  // If it's a blob URI or http/https URI, fetch it
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Convert to base64
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  const mimeType = blob.type || 'image/jpeg';
  return `data:${mimeType};base64,${base64}`;
}


// ─── RelayExtractor ─────────────────────────────────────────────────────────

export class RelayExtractor implements FlyerExtractor {
  /**
   * Extract prices from a flyer image via the relay server.
   *
   * @param image - File URI or base64 data URL of the flyer image
   * @returns Array of ScannedFlyerPrice entries (empty on failure)
   */
  async extract(image: string): Promise<ScannedFlyerPrice[]> {
    try {
      const baseUrl = getRelayHttpBaseUrl();
      const relayToken = await getRelayToken();

      if (!baseUrl || !relayToken) {
        console.warn('[relay-extractor] Relay not configured or not enrolled');
        return [];
      }

      // Convert image to base64 if it's a file URI
      const dataUri = await fileUriToBase64(image);

      // Extract the raw base64 from data URI
      const commaIndex = dataUri.indexOf(',');
      if (commaIndex === -1) {
        console.warn('[relay-extractor] Invalid data URI');
        return [];
      }

      const base64Data = dataUri.slice(commaIndex + 1);
      const formatMatch = dataUri.match(/^data:image\/(\w+);/);
      const format = formatMatch?.[1] ?? 'jpeg';

      // POST to relay server with 30s timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);

      const response = await fetch(`${baseUrl}/api/extract/flyer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${relayToken}`,
        },
        body: JSON.stringify({
          image: base64Data,
          format,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[relay-extractor] Server returned ${response.status}`);
        return [];
      }

      const data: ExtractResponse = await response.json();
      const prices = data.prices ?? [];

      // Map to ScannedFlyerPrice shape
      return prices.map((p) => ({
        itemName: p.itemName,
        storeId: '',
        storeName: '',
        price: p.price,
        unit: p.unit || 'each',
        quantity: p.quantity || 1,
        saleInfo: buildSaleInfo(p.saleInfo),
        scannedAt: Date.now(),
        validTo: p.saleInfo?.saleEndDate ?? null,
        confidence: p.confidence ?? 0.5,
      }));
    } catch (err) {
      console.warn(
        `[relay-extractor] Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const relayExtractor = new RelayExtractor();
