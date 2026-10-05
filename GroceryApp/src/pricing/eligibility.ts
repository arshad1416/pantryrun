/**
 * Eligibility — may this offer be used for this item on the shopping date,
 * and how good is the evidence behind it?
 *
 * Two separate answers:
 *
 *  1. Eligible (usable in a plan at all). Not when the offer is withdrawn,
 *     expired, not yet started, ends before the shopping window does,
 *     is older than MAX_PRICE_AGE_MS, is demo data, is out of stock, needs
 *     a membership the person hasn't confirmed, is for another channel /
 *     city / branch, isn't a sale for a "sale only" item, or is a
 *     different product variant.
 *
 *  2. Verified (may support an unconditional "cheapest" claim). Eligible
 *     AND none of these caveats: demo, crowd-reported, scraped, unknown
 *     source, unknown branch, unknown channel, unknown stock, observation
 *     older than VERIFIED_MAX_AGE_MS, or a failed last refresh.
 *
 * Dates. Eligibility is judged for the shopping window [shoppingDate,
 * shoppingThrough] in the store's local time zone, not "now":
 *  - `validTo` (an instant) must last through the end of the window's
 *    last local day. A sale ending Wednesday 23:59 does not cover a
 *    Monday–Sunday shopping week.
 *  - `validThroughDate` (date only — the source gave no time) is good
 *    through that local day, and not on the next local day. No time is
 *    invented.
 *  - An offer with no end date is not assumed to expire; its freshness is
 *    judged by observation age alone.
 *
 * Pure functions only.
 */

import type { PriceResult } from './types';
import { checkVariant, parseItemIntent, type ItemIntent } from './intent';

// ─── Context ────────────────────────────────────────────────────────────────

/** Observed prices older than this are not used at all. */
export const MAX_PRICE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Observed prices older than this are usable but not verified. */
export const VERIFIED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_TIME_ZONE = 'America/Toronto';

export interface PlanContext {
  /** The clock (epoch ms). Pinned in tests. */
  now?: number;
  /** First local shopping day, YYYY-MM-DD (default: today in `timeZone`). */
  shoppingDate?: string;
  /** Last local shopping day, YYYY-MM-DD (default: `shoppingDate`). */
  shoppingThrough?: string;
  /** IANA zone for stores that don't carry their own. */
  timeZone?: string;
  maxAgeMs?: number;
  verifiedMaxAgeMs?: number;
  /** Allow seeded demo prices (dev builds only). They are never verified. */
  includeDemo?: boolean;
  /** Memberships the person has confirmed, e.g. ['costco']. */
  memberships?: string[];
  /** Where the person is shopping. */
  channel?: 'in_store' | 'online' | 'pickup';
  /** The person's city; an offer from another city is ineligible. */
  city?: string;
  /** Chosen branch per store; an offer from another branch is ineligible. */
  branchIds?: Record<string, string>;
  /** Treat "sale only" holds as needed now (fulfilment incomplete without them). */
  requireHeldItems?: boolean;
}

export type IneligibleReason =
  | 'withdrawn'
  | 'expired'
  | 'expires_before_shopping'
  | 'not_started'
  | 'stale'
  | 'demo'
  | 'out_of_stock'
  | 'membership_unconfirmed'
  | 'wrong_channel'
  | 'wrong_city'
  | 'wrong_branch'
  | 'not_on_sale'
  | 'variant_mismatch'
  | 'variant_unverified';

export type EvidenceCaveat =
  | 'demo'
  | 'crowd_reported'
  | 'scraped'
  | 'source_unknown'
  | 'branch_unknown'
  | 'channel_unknown'
  | 'stock_unknown'
  | 'aging'
  | 'refresh_failed';

export interface OfferAssessment {
  eligible: boolean;
  reasons: IneligibleReason[];
  caveats: EvidenceCaveat[];
  verified: boolean;
}

// ─── Local dates ────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(ms: number, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** Local calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDate(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
function zoneOffset(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** First instant of local day `date` (YYYY-MM-DD) in `timeZone`. */
export function startOfLocalDay(date: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - zoneOffset(guess, timeZone);
  t = guess - zoneOffset(t, timeZone); // second pass settles DST edges
  return t;
}

/** First instant of the local day after `date`. */
export function startOfNextLocalDay(date: string, timeZone: string): number {
  return startOfLocalDay(addLocalDays(date, 1), timeZone);
}

/** YYYY-MM-DD `n` calendar days after `date`. */
export function addLocalDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The device's IANA time zone, or DEFAULT_TIME_ZONE when unavailable. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolved shopping window for one store's time zone. */
export interface ShoppingWindow {
  timeZone: string;
  now: number;
  /** YYYY-MM-DD, never before today */
  from: string;
  through: string;
  /** First instant of `from`, last instant (exclusive) of `through` */
  startMs: number;
  endMs: number;
}

export function shoppingWindow(ctx: PlanContext, timeZone?: string): ShoppingWindow {
  const tz = timeZone ?? ctx.timeZone ?? DEFAULT_TIME_ZONE;
  const now = ctx.now ?? Date.now();
  const today = localDate(now, tz);
  const requested = ctx.shoppingDate && DATE_RE.test(ctx.shoppingDate) ? ctx.shoppingDate : today;
  const from = requested < today ? today : requested;
  const throughRaw = ctx.shoppingThrough && DATE_RE.test(ctx.shoppingThrough) ? ctx.shoppingThrough : from;
  const through = throughRaw < from ? from : throughRaw;
  return {
    timeZone: tz,
    now,
    from,
    through,
    startMs: startOfLocalDay(from, tz),
    endMs: startOfNextLocalDay(through, tz),
  };
}

// ─── Assessment ─────────────────────────────────────────────────────────────

/** Explicit promotional evidence; a flyer listing counts unless marked regular. */
export function isSaleOffer(pr: PriceResult): boolean {
  if (pr.offerType === 'regular') return false;
  if (pr.offerType === 'sale') return true;
  if (pr.source.tier === 'flyer') return true;
  return !!pr.saleInfo?.isOnSale && pr.saleInfo.unitPriceVsRegular <= 0;
}

/** One minute of slack so a "23:59:00" end still covers its own day. */
const END_OF_DAY_SLACK_MS = 60 * 1000;

function timeReasons(pr: PriceResult, w: ShoppingWindow): IneligibleReason[] {
  const out: IneligibleReason[] = [];
  const today = localDate(w.now, w.timeZone);

  if (pr.validThroughDate !== undefined) {
    if (pr.validThroughDate < today) out.push('expired');
    else if (pr.validThroughDate < w.through) out.push('expires_before_shopping');
  }
  if (pr.validTo !== undefined) {
    if (pr.validTo < w.now) out.push('expired');
    else if (pr.validTo < w.endMs - END_OF_DAY_SLACK_MS) out.push('expires_before_shopping');
  }
  if (pr.validFromDate !== undefined && pr.validFromDate > w.from) out.push('not_started');
  if (pr.validFrom !== undefined && pr.validFrom > w.startMs + END_OF_DAY_SLACK_MS) out.push('not_started');
  return [...new Set(out)];
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Judge one offer for one item. `intent` may be passed when the caller has
 * already parsed it (the solver does, once per item).
 */
export function assessOffer(
  pr: PriceResult,
  item: { name: string; notes?: string },
  ctx: PlanContext = {},
  intent: ItemIntent = parseItemIntent(item),
): OfferAssessment {
  const w = shoppingWindow(ctx, pr.source.timeZone);
  const reasons: IneligibleReason[] = [];
  const caveats: EvidenceCaveat[] = [];

  if (pr.unavailable === 'withdrawn') reasons.push('withdrawn');
  reasons.push(...timeReasons(pr, w));

  const age = Math.max(w.now, w.startMs) - pr.timestamp;
  if (age > (ctx.maxAgeMs ?? MAX_PRICE_AGE_MS)) reasons.push('stale');
  else if (age > (ctx.verifiedMaxAgeMs ?? VERIFIED_MAX_AGE_MS)) caveats.push('aging');

  if (pr.isDemo) {
    if (ctx.includeDemo) caveats.push('demo');
    else reasons.push('demo');
  }
  if (pr.stockStatus === 'out_of_stock') reasons.push('out_of_stock');
  if (pr.requiresMembership && !(ctx.memberships ?? []).some((m) => sameText(m, pr.requiresMembership!))) {
    reasons.push('membership_unconfirmed');
  }
  if (ctx.channel && pr.channel && pr.channel !== ctx.channel) reasons.push('wrong_channel');
  if (ctx.city && pr.source.city && !sameText(ctx.city, pr.source.city)) reasons.push('wrong_city');
  const wantedBranch = ctx.branchIds?.[pr.source.storeId];
  if (wantedBranch && pr.source.branchId && pr.source.branchId !== wantedBranch) reasons.push('wrong_branch');

  if (intent.saleOnly && !isSaleOffer(pr)) reasons.push('not_on_sale');
  const variant = checkVariant(intent, pr.matchedName);
  if (variant === 'mismatch') reasons.push('variant_mismatch');
  if (variant === 'unverified') reasons.push('variant_unverified');

  // Evidence caveats — only matter for offers that are otherwise usable.
  if (pr.source.tier === 'crowd') caveats.push('crowd_reported');
  if (pr.source.tier === 'scraping') caveats.push('scraped');
  if (!pr.source.adapterId) caveats.push('source_unknown');
  if (!pr.source.branchId) caveats.push('branch_unknown');
  if (!pr.channel) caveats.push('channel_unknown');
  if (pr.stockStatus !== 'in_stock') caveats.push('stock_unknown');
  if (pr.refreshFailedAt !== undefined) caveats.push('refresh_failed');

  const eligible = reasons.length === 0;
  return { eligible, reasons, caveats, verified: eligible && caveats.length === 0 };
}
