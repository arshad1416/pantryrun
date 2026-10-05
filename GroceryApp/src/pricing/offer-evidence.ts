/**
 * Offer evidence, validity and freshness.
 *
 * An offer is judged against the intended SHOPPING WINDOW in the store's
 * local timezone — not the day it was fetched. Expired, not-yet-valid,
 * stale, withdrawn and out-of-stock offers fail closed: they are excluded
 * from verified recommendations and the reason is reported, but the record
 * itself is kept so the history is not erased.
 *
 * Freshness policy (max age of the observation, by provenance):
 *   verified    7 days   (documented retailer source, re-checked weekly)
 *   manual     14 days   (a price you or your family entered)
 *   flyer      through its printed end date; 7 days if the flyer has none
 *   unverified 24 hours  (adapter output with no validity information)
 *   demo       never fresh enough to verify; shown only as sample data
 */

import type { OfferEvidence, OfferProvenance, PriceResult } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export const FRESHNESS_POLICY_MS: Record<OfferProvenance, number> = {
  verified: 7 * DAY_MS,
  manual: 14 * DAY_MS,
  flyer: 7 * DAY_MS,
  unverified: 1 * DAY_MS,
  demo: Number.POSITIVE_INFINITY,
};

export const PROVENANCE_LABEL: Record<OfferProvenance, string> = {
  verified: 'Verified source',
  manual: 'Entered by you',
  flyer: 'Flyer',
  unverified: 'Unverified',
  demo: 'Sample price — not a real store price',
};

/** Evidence for an offer; a legacy result without evidence is 'unverified'. */
export function getEvidence(pr: PriceResult): OfferEvidence {
  if (pr.evidence) {
    return { observedAt: pr.timestamp, ...pr.evidence };
  }
  // A flyer-tier result is a printed promotion even without evidence.
  if (pr.source?.tier === 'flyer') {
    return { provenance: 'flyer', sourceLabel: pr.source.adapterId, observedAt: pr.timestamp, isSale: true };
  }
  return {
    provenance: 'unverified',
    sourceLabel: pr.source?.adapterId,
    observedAt: pr.timestamp,
  };
}

const TIER_LABELS: Record<string, string> = {
  official: 'Store',
  flyer: 'Flyer',
  crowd: 'Crowd',
  scraping: 'Web',
};

/**
 * Short provenance label for a price badge, e.g. "Flyer · ends Oct 9",
 * "Crowd · 3d ago", "Sample" — so a seeded or old price never reads as a
 * current shelf price.
 */
export function describeEvidence(pr: PriceResult, now: number = Date.now()): string {
  const ev = getEvidence(pr);
  if (ev.provenance === 'demo') return 'Sample';
  const tier = ev.provenance === 'manual' ? 'You' : TIER_LABELS[pr.source.tier] ?? pr.source.tier;
  if (ev.validTo) return `${tier} · ends ${formatDay(ev.validTo).slice(4)}`;
  const days = Math.floor((now - (ev.observedAt ?? pr.timestamp)) / DAY_MS);
  return `${tier} · ${days <= 0 ? 'today' : `${days}d ago`}`;
}

/** A shopping window: first and last day, inclusive, as YYYY-MM-DD. */
export interface ShoppingWindow {
  start: string;
  end: string;
}

/** Calendar date of `ts` in `timeZone` (falls back to the device zone). */
export function localDate(ts: number, timeZone?: string): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(ts));
      const get = (t: string) => parts.find((p) => p.type === t)?.value;
      const y = get('year');
      const m = get('month');
      const d = get('day');
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch {
      // Unknown zone or no Intl timezone data — use the device zone.
    }
  }
  const dt = new Date(ts);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!) + days * DAY_MS);
  return dt.toISOString().slice(0, 10);
}

/** A window starting today (device zone) and lasting `days` days. */
export function windowFromToday(now: number, days = 1, startOffsetDays = 0): ShoppingWindow {
  const start = addDays(localDate(now), startOffsetDays);
  return { start, end: addDays(start, Math.max(1, days) - 1) };
}

/** "Wed Oct 7" for a YYYY-MM-DD date. */
export function formatDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getUTCMonth()];
  return `${wd} ${mo} ${d}`;
}

export type ValidityStatus =
  | { status: 'valid' }
  /** Valid for part of the window only — usable, but the restriction must be shown. */
  | { status: 'restricted'; note: string }
  | { status: 'excluded'; reason: string };

/**
 * Judge an offer against the shopping window and the freshness policy.
 * `now` is passed in (never read from the clock) so results are reproducible.
 */
export function evaluateValidity(
  ev: OfferEvidence,
  window: ShoppingWindow,
  now: number,
): ValidityStatus {
  if (ev.withdrawn) return { status: 'excluded', reason: 'offer withdrawn by the source' };
  if (ev.stockStatus === 'out_of_stock') return { status: 'excluded', reason: 'out of stock' };

  if (ev.validTo && ev.validTo < window.start) {
    return { status: 'excluded', reason: `offer ended ${formatDay(ev.validTo)}` };
  }
  if (ev.validFrom && ev.validFrom > window.end) {
    return { status: 'excluded', reason: `offer starts ${formatDay(ev.validFrom)}, after your shopping window` };
  }

  const age = ev.observedAt != null ? now - ev.observedAt : Number.POSITIVE_INFINITY;
  const flyerWithDates = ev.provenance === 'flyer' && !!ev.validTo;
  if (!flyerWithDates && ev.provenance !== 'demo' && age > FRESHNESS_POLICY_MS[ev.provenance]) {
    const days = Number.isFinite(age) ? Math.floor(age / DAY_MS) : null;
    return {
      status: 'excluded',
      reason: days != null ? `price is ${days} day${days === 1 ? '' : 's'} old (stale)` : 'price has no observation date',
    };
  }

  const notes: string[] = [];
  if (ev.validTo && ev.validTo < window.end) notes.push(`price valid only through ${formatDay(ev.validTo)}`);
  if (ev.validFrom && ev.validFrom > window.start) notes.push(`price starts ${formatDay(ev.validFrom)}`);
  if (ev.stockStatus === 'limited') notes.push('limited stock');
  if (notes.length > 0) return { status: 'restricted', note: notes.join('; ') };
  return { status: 'valid' };
}
