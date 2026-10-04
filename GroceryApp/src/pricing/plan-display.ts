/**
 * Plan display — the exact words every price view uses, derived from one
 * BasketPlan so store cards, route cards, the trip sheet and list rows can
 * never disagree. Pure, so the wording is tested rather than eyeballed.
 */

import type { BasketPlan, Candidate, EvidenceMix, RouteProposal } from './basket-planner';
import { savingsAreClaimable } from './basket-planner';
import { PROVENANCE_LABEL, formatDay, type ShoppingWindow } from './offer-evidence';
import type { OfferProvenance } from './types';

export const money = (n: number) => `$${n.toFixed(2)}`;

export function coverageLabel(covered: number, eligible: number): string {
  return `${covered} of ${eligible} item${eligible === 1 ? '' : 's'}`;
}

export function windowLabel(w: ShoppingWindow): string {
  return w.start === w.end ? formatDay(w.start) : `${formatDay(w.start)} – ${formatDay(w.end)}`;
}

const SHORT_PROVENANCE: Record<OfferProvenance, string> = {
  verified: 'verified',
  manual: 'entered by you',
  flyer: 'flyer',
  unverified: 'unverified',
  demo: 'sample',
};

/** "6 entered by you · 2 flyer · 2 sample" — what backs a total. */
export function evidenceLabel(mix: EvidenceMix): string {
  return (Object.keys(SHORT_PROVENANCE) as OfferProvenance[])
    .filter((k) => mix[k] > 0)
    .map((k) => `${mix[k]} ${SHORT_PROVENANCE[k]}`)
    .join(' · ');
}

export function provenanceLabel(p: OfferProvenance): string {
  return PROVENANCE_LABEL[p];
}

/**
 * The savings sentence for a route card, or null when no saving may be
 * stated. Never claims a saving between routes that cover different items.
 */
export function savingsStatement(p: RouteProposal, prev: RouteProposal | undefined): string | null {
  if (!prev || p.savingsVsPrevious == null) {
    return prev ? 'Covers different items than the route before — totals not comparable' : null;
  }
  if (p.savingsVsPrevious <= 0) return null;
  const amount = money(p.savingsVsPrevious);
  const vs = `${prev.stores.length} stop${prev.stores.length === 1 ? '' : 's'}`;
  if (!savingsAreClaimable(p) || p.evidence.demo > 0 || prev.evidence.demo > 0) {
    return `Illustrative only (sample prices): ${amount} less than ${vs}`;
  }
  return `Saves ${amount} vs ${vs}, before tax and travel`;
}

/** Whether an extra stop pays for itself, given an optional per-stop cost. */
export function extraStopNote(p: RouteProposal, extraStopCost: number | undefined): string | null {
  if (p.savingsVsPrevious == null || p.savingsVsPrevious <= 0 || extraStopCost == null) return null;
  return p.savingsVsPrevious > extraStopCost
    ? `Worth it if a stop costs you less than ${money(p.savingsVsPrevious)}`
    : `Not worth it at ${money(extraStopCost)} per stop`;
}

export interface ItemPriceInfo {
  /** Amount to show, or null when the line is held / unavailable. */
  amount: number | null;
  caption: string;
  tone: 'ok' | 'warn' | 'held';
}

function fromCandidate(c: Candidate, withStore: boolean): ItemPriceInfo {
  if (c.verdict === 'excluded') {
    return { amount: null, caption: `${withStore ? `${c.storeName}: ` : ''}${c.reasons[0] ?? 'not usable'}`, tone: 'held' };
  }
  const parts = [withStore ? c.storeName : '', c.purchaseDescription ?? ''];
  if (c.verdict === 'substitute') parts.push('substitute');
  if (c.restriction) parts.push(c.restriction);
  if (c.provenance === 'demo') parts.push('sample price');
  else if (c.provenance === 'unverified') parts.push('unverified');
  const warn = c.verdict === 'substitute' || !!c.restriction || c.provenance === 'demo' || c.provenance === 'unverified';
  return { amount: c.lineTotal ?? null, caption: parts.filter(Boolean).join(' · '), tone: warn ? 'warn' : 'ok' };
}

/**
 * Price shown on a list row. In a store view: that store's offer or why it
 * can't be used. In a route view: the route's assignment. Otherwise: the
 * cheapest usable offer, labelled with its store.
 */
export function itemPriceInfo(
  plan: BasketPlan,
  itemId: string,
  view: { storeId?: string | null; route?: RouteProposal | null },
): ItemPriceInfo | null {
  const la = plan.lines.find((l) => l.line.itemId === itemId);
  if (!la || la.status === 'not_buying') return null;

  if (view.route) {
    const a = view.route.assignments.find((x) => x.itemId === itemId);
    if (a) return fromCandidate(a.candidate, true);
  }
  if (view.storeId) {
    const c = la.candidates.find((x) => x.storeId === view.storeId);
    if (c) return fromCandidate(c, false);
    if (la.status === 'held') return { amount: null, caption: la.reasons[0] ?? 'held', tone: 'held' };
    return { amount: null, caption: 'no price at this store', tone: 'held' };
  }
  if (la.status === 'held') return { amount: null, caption: `held: ${la.reasons[0] ?? ''}`, tone: 'held' };

  let best: Candidate | null = null;
  for (const c of la.candidates) {
    if (c.verdict === 'excluded') continue;
    if (!best || c.lineTotal! < best.lineTotal!) best = c;
  }
  return best ? fromCandidate(best, true) : null;
}
