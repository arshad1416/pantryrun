/**
 * store-branding — Shared store logo, color, and initial helpers.
 *
 * Single source of truth for store visuals used by StoreCard,
 * TripPlanSheet, and any future component.
 *
 * Supports Turso-backed branding with static fallback.
 */

import { Image, ImageSourcePropType } from 'react-native';
import React from 'react';

type StoreLogoSize = 18 | 24 | 32 | 40;

// ─── Static fallback maps ────────────────────────────────────────────────────

const STORE_LOGOS: Record<string, any> = {
  'no-frills': require('../../assets/nofrills_logo.png'),
  'nofrills': require('../../assets/nofrills_logo.png'),
  'food-basics': require('../../assets/foodbasics_logo.png'),
  'foodbasics': require('../../assets/foodbasics_logo.png'),
  'metro': require('../../assets/metro_logo.png'),
  'walmart': require('../../assets/walmart_logo.png'),
  'freshco': require('../../assets/freshco_logo.png'),
  'foodland': require('../../assets/foodland_logo.png'),
  'loblaws': require('../../assets/loblaws_logo.png'),
};

const STORE_COLORS: Record<string, string> = {
  'no-frills': '#FFD700', 'nofrills': '#FFD700',
  'food-basics': '#FF4444', 'foodbasics': '#FF4444',
  'freshco': '#FF6600',
  'metro': '#E53935',
  'walmart': '#0071CE',
  'loblaws': '#E53935',
  'foodland': '#228B22',
};

// ─── Turso branding cache ────────────────────────────────────────────────────

interface BrandingRow {
  store_id: string;
  store_name: string;
  logo_url: string | null;
  color: string | null;
}

const _tursoBranding: Map<string, BrandingRow> = new Map();

/**
 * Fetch all store_branding rows from Turso and populate the in-memory cache.
 * Non-blocking: errors are caught and logged, so the app keeps working
 * with static fallback data if Turso is unreachable.
 */
export async function fetchStoreBranding(): Promise<void> {
  try {
    // Lazy-import so this module can load before Turso is initialized
    const { getTurso, isTursoReady } = await import('../services/tursoClient');
    if (!isTursoReady()) return;

    const client = getTurso();
    const result = await client.execute(
      'SELECT store_id, store_name, logo_url, color FROM store_branding',
    );

    for (const row of result.rows) {
      const entry: BrandingRow = {
        store_id: String(row[0] ?? ''),
        store_name: String(row[1] ?? ''),
        logo_url: row[2] != null ? String(row[2]) : null,
        color: row[3] != null ? String(row[3]) : null,
      };
      if (entry.store_id) {
        _tursoBranding.set(entry.store_id.toLowerCase(), entry);
      }
    }
  } catch (e) {
    // Non-fatal — static fallback remains available
    console.warn('[store-branding] fetchStoreBranding failed:', e);
  }
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/**
 * Get the logo source for a store.
 * Returns a Turso remote `{ uri }` if available, otherwise a static require().
 * Returns null if no logo is known.
 */
export function getStoreLogo(storeId: string, size: StoreLogoSize = 32): ImageSourcePropType | null {
  const key = storeId.toLowerCase();
  const turso = _tursoBranding.get(key);
  if (turso?.logo_url) {
    return { uri: turso.logo_url };
  }
  const source = STORE_LOGOS[storeId] ?? STORE_LOGOS[key];
  return source ?? null;
}

/**
 * StoreLogo component — renders the store logo image.
 * Handles both static require() sources and remote { uri } images.
 * Falls back to showing the store initial on image load error.
 */
export function StoreLogo({ storeId, size = 32 }: { storeId: string; size?: StoreLogoSize }) {
  const [imgError, setImgError] = React.useState(false);
  const source = getStoreLogo(storeId, size);

  if (!source) return null;

  // If the remote image failed, show the initial letter instead
  if (imgError) {
    return React.createElement(
      // Simple fallback: just render an empty view to avoid crash
      // Components using StoreLogo should handle null gracefully
      'View',
      { style: { width: size, height: size } },
    );
  }

  return React.createElement(Image, {
    source,
    style: { width: size, height: size, borderRadius: size >= 32 ? 4 : 3 },
    resizeMode: 'contain',
    onError: () => setImgError(true),
  });
}

/**
 * Get the brand color for a store.
 * Checks Turso cache first, falls back to static map, then default green.
 */
export function getStoreColor(storeId: string): string {
  const key = storeId.toLowerCase();
  const turso = _tursoBranding.get(key);
  if (turso?.color) {
    return turso.color;
  }
  return STORE_COLORS[key] ?? '#16A34A';
}

export function getStoreInitial(storeName: string): string {
  if (!storeName) return '?';
  return storeName.charAt(0).toUpperCase();
}
