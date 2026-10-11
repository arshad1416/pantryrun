/**
 * ProductLookup — the lookup chain for barcode product data.
 *
 * Order: in-memory cache → Turso DB → Open Food Facts API → USDA API
 *
 * Results are cached in-memory so repeated scans of the same item
 * in one session are instant. Turso is the long-term persistent cache.
 * Open Food Facts and USDA are free external sources.
 */

import { getCachedProduct, setCachedProduct } from './productCache';
import { getTurso, isTursoReady } from './tursoClient';
import { cleanProductName } from './aiCleanup';
import { getSettings } from '../config/settings';
import type { ProductInfo, CleanedProduct, NewProductSubmission, ScanResult } from '../types/product';

// ─── Config ──────────────────────────────────────────────────────────────────

const USDA_API_KEY = process.env.EXPO_PUBLIC_USDA_API_KEY ?? '';

// ─── External API helpers ─────────────────────────────────────────────────────

/** Look up a product via Open Food Facts. Free, no key, 15 req/min. */
async function lookupOpenFoodFacts(barcode: string): Promise<ProductInfo | null> {
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.status === 429) {
      console.warn('[productLookup] Open Food Facts rate limited (429). Backing off.');
      return null;
    }
    if (!res.ok) return null;

    const data = await res.json();
    if (data.status !== 1 || !data.product) return null;

    const p = data.product;
    return {
      barcode,
      productName: p.product_name || p.product_name_en || 'Unknown Product',
      brand: p.brands || undefined,
      category: p.categories ? p.categories.split(',').map((c: string) => c.trim()).filter(Boolean)[0] : undefined,
      imageUrl: p.image_url || undefined,
      quantityLabel: p.quantity || undefined,
      source: 'open_food_facts',
    };
  } catch {
    return null;
  }
}

/**
 * A GTIN/UPC/EAN as comparable digits: the same product is printed as a
 * 12-digit UPC-A, a 13-digit EAN or a zero-padded 14-digit GTIN, so leading
 * zeros don't count.
 */
export function normalizeGtin(code: unknown): string {
  return String(code ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

/**
 * Look up a product via USDA FoodData Central. Free, needs API key.
 *
 * The search endpoint is full-text: a barcode query returns whatever foods
 * mention those digits anywhere, ranked by relevance — the first hit is
 * often a different product. Only a branded food whose gtinUpc IS the
 * scanned code is accepted.
 */
async function lookupUSDA(barcode: string): Promise<ProductInfo | null> {
  if (!USDA_API_KEY) return null;
  const wanted = normalizeGtin(barcode);
  if (!wanted) return null;

  try {
    const res = await fetch(
      `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(barcode)}&dataType=Branded&api_key=${USDA_API_KEY}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;

    const data = await res.json();
    if (!Array.isArray(data.foods) || data.foods.length === 0) return null;

    const p = data.foods.find((f: { gtinUpc?: unknown }) => normalizeGtin(f?.gtinUpc) === wanted);
    if (!p) return null;
    return {
      barcode,
      productName: p.description || 'Unknown Product',
      brand: p.brandName || undefined,
      category: p.foodCategory ? p.foodCategory.split(',').map((c: string) => c.trim())[0] : undefined,
      quantityLabel: p.servingSize
        ? `${p.servingSize} ${p.servingSizeUnit ?? 'g'}`
        : undefined,
      source: 'usda',
    };
  } catch {
    return null;
  }
}

/** Look up in Turso (user-contributed products). */
async function lookupTurso(barcode: string): Promise<ProductInfo | null> {
  if (!isTursoReady()) return null;

  try {
    const db = getTurso();
    const result = await db.execute(
      'SELECT product_name, brand, category, image_url, quantity_label FROM products WHERE barcode = ?',
      [barcode],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      barcode,
      productName: String(row[0] ?? 'Unknown Product'),
      brand: row[1] ? String(row[1]) : undefined,
      category: row[2] ? String(row[2]) : undefined,
      imageUrl: row[3] ? String(row[3]) : undefined,
      quantityLabel: row[4] ? String(row[4]) : undefined,
      source: 'turso',
    };
  } catch {
    return null;
  }
}

// ─── Main public functions ───────────────────────────────────────────────────

/**
 * Look up a product by barcode through the full chain.
 * Results are cached in-memory regardless of source.
 */
export async function lookupProduct(barcode: string): Promise<ScanResult> {
  // Consent gate: barcode lookups are opt-in (barcodeScanningEnabled, default
  // false). The scanner entry points ask for consent before the camera opens,
  // so this is defence-in-depth — no caller can reach the network without it.
  if (!(getSettings().barcodeScanningEnabled ?? false)) {
    return {
      status: 'lookup_error',
      barcode,
      error: 'Barcode lookups are turned off. Enable barcode scanning in Settings to look up products.',
    };
  }

  // 1. In-memory cache
  const cached = getCachedProduct(barcode);
  if (cached) return { status: 'found', product: cached };

  try {
    let product: ProductInfo | null = null;

    // 2. Turso (user-contributed)
    if (!product) product = await lookupTurso(barcode);

    // 3. Open Food Facts (free, no key)
    if (!product) product = await lookupOpenFoodFacts(barcode);

    // 4. USDA (free fallback)
    if (!product) product = await lookupUSDA(barcode);

    if (product) {
      setCachedProduct(product);
      return { status: 'found', product };
    }

    return { status: 'not_found', barcode };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown lookup error';
    return { status: 'lookup_error', barcode, error: errorMsg };
  }
}

/**
 * Save a user-submitted product to Turso.
 * The raw name is passed through AI cleanup before storing.
 */
export async function submitNewProduct(submission: NewProductSubmission): Promise<CleanedProduct> {
  if (!isTursoReady()) {
    throw new Error('Turso not configured. Connect a Turso database in Settings.');
  }

  const db = getTurso();

  // AI cleanup — normalize the raw name
  const cleaned = await cleanProductName(submission.rawName);

  const product: CleanedProduct = {
    barcode: submission.barcode,
    productName: cleaned.productName || submission.rawName.trim(),
    brand: cleaned.brand ?? submission.brand ?? null,
    category: cleaned.category ?? submission.category ?? null,
    imageUrl: null,
    quantityLabel: submission.quantityLabel ?? cleaned.quantityLabel ?? null,
    source: 'turso',
    rawInput: submission.rawName.trim(),
    aiCleaned: true,
    firstSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Build batch statements — product INSERT first (FK target), then optional price INSERT
  const statements: { sql: string; args?: (string | number | null)[] }[] = [
    {
      sql: `INSERT INTO products (barcode, product_name, brand, category, image_url, quantity_label, source, raw_input, ai_cleaned, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'turso', ?, 1, datetime('now'), datetime('now'))
           ON CONFLICT(barcode) DO UPDATE SET
             product_name = excluded.product_name,
             brand = excluded.brand,
             category = excluded.category,
             quantity_label = excluded.quantity_label,
             raw_input = excluded.raw_input,
             ai_cleaned = 1,
             updated_at = datetime('now')`,
      args: [
        product.barcode,
        product.productName,
        product.brand,
        product.category,
        product.imageUrl,
        product.quantityLabel,
        product.rawInput,
      ],
    },
  ];

  // If user submitted a price at the same time, log it in the same batch
  if (submission.price) {
    statements.push({
      sql: `INSERT INTO product_prices (barcode, price, store_name, store_id, scanned_at, submitted_by)
           VALUES (?, ?, ?, ?, datetime('now'), ?)`,
      args: [
        submission.barcode,
        submission.price.amount,
        submission.price.storeName,
        submission.price.storeId,
        'system',
      ],
    });
  }

  const batchResult = await db.batch(statements);

  // Check if any statement in the batch failed
  for (const result of batchResult.results) {
    if ('error' in result) {
      throw new Error(`Turso batch error: ${result.error}`);
    }
  }

  // Cache the result for this session
  setCachedProduct({
    barcode: product.barcode,
    productName: product.productName,
    brand: product.brand ?? undefined,
    category: product.category ?? undefined,
    imageUrl: product.imageUrl ?? undefined,
    quantityLabel: product.quantityLabel ?? undefined,
    source: 'turso',
  });

  return product;
}

/**
 * Load recent price history for a product from Turso.
 */
export async function getPriceHistory(
  barcode: string,
  limit = 20,
): Promise<{ price: number; storeName: string; scannedAt: string }[]> {
  if (!isTursoReady()) return [];

  try {
    const db = getTurso();
    const result = await db.execute(
      `SELECT price, store_name, scanned_at
       FROM product_prices
       WHERE barcode = ?
       ORDER BY scanned_at DESC
       LIMIT ?`,
      [barcode, limit],
    );

    return result.rows.map((row) => ({
      price: Number(row[0]),
      storeName: String(row[1]),
      scannedAt: String(row[2]),
    }));
  } catch {
    return [];
  }
}
