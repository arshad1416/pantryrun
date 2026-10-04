/**
 * Basket planner — the single comparison engine behind store totals, route
 * cards, the trip plan and the per-item price shown in the list.
 *
 * Pipeline:
 *   1. Each list line → BasketLine (list-intent.ts).
 *   2. Each (line, store offer) → a Candidate with a verdict and reasons
 *      (evaluateCandidate): exact, substitute, or excluded.
 *   3. The comparable basket = lines with at least one usable candidate.
 *      Lines that are checked, zero, of unknown quantity, or have no usable
 *      offer anywhere are HELD and listed with their reasons — never priced
 *      at $0.
 *   4. For k = 1..maxStops (≤ 3) the planner enumerates every set of ≤ k
 *      stores and, within a set, buys each line where its pack-correct line
 *      total is lowest. Sets are ranked coverage-first, then merchandise
 *      total, then fewer stores, then store id — deterministic, and exact
 *      (no greedy step), so an incomplete route can never outrank a complete
 *      one by leaving items out.
 *   5. Savings are only stated between routes that cover the SAME lines, and
 *      are merchandise-only: tax, travel, delivery and membership costs are
 *      unknown, not zero, and are reported separately.
 */

import type { PriceResult, OfferEvidence, OfferProvenance } from './types';
import {
  deriveBasketLine,
  parseVariantAttributes,
  productMatches,
  requirementLabel,
  variantGroup,
  type BasketLine,
  type LineSource,
} from './list-intent';
import { evaluateValidity, getEvidence, type ShoppingWindow } from './offer-evidence';
import { planPurchase, roundMoney, type Quantity } from './units';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlannerContext {
  window: ShoppingWindow;
  /** Evaluation time (epoch ms) — passed in so results are reproducible. */
  now: number;
  /** Memberships the shopper holds (e.g. ['Costco']). */
  memberships?: string[];
  /** Shopping channel being planned. Default 'in_store'. */
  channel?: 'in_store' | 'online' | 'delivery';
  /** Currency the comparison is in. Default 'CAD'. */
  currency?: string;
  /** Pinned branch per store, when the shopper has chosen one. */
  branchByStore?: Record<string, string>;
}

export type Verdict = 'exact' | 'substitute' | 'excluded';

export interface Candidate {
  storeId: string;
  storeName: string;
  verdict: Verdict;
  /** Why it was excluded, or why it is only a substitute. */
  reasons: string[];
  /** Partial-window or stock restriction the shopper must see. */
  restriction?: string;
  provenance: OfferProvenance;
  sourceLabel?: string;
  productName?: string;
  shelfPrice: number;
  priceBasis: NonNullable<OfferEvidence['priceBasis']>;
  packageSize?: Quantity;
  packs?: number;
  purchased?: Quantity;
  lineTotal?: number;
  purchaseDescription?: string;
}

export type LineStatus = 'eligible' | 'held' | 'not_buying';

export interface LineAnalysis {
  line: BasketLine;
  status: LineStatus;
  /** Why the line is held / not being bought. */
  reasons: string[];
  /** Every store's offer for this line, usable or not. */
  candidates: Candidate[];
}

export interface Assignment {
  itemId: string;
  name: string;
  candidate: Candidate;
}

export type EvidenceMix = Record<OfferProvenance, number>;

export interface RouteProposal {
  /** Store limit this proposal was planned under. */
  maxStops: number;
  /** Stores actually visited (≤ maxStops). */
  stores: { storeId: string; storeName: string; subtotal: number; itemIds: string[] }[];
  assignments: Assignment[];
  merchandiseTotal: number;
  coveredItemIds: string[];
  /** Eligible lines this route cannot buy. */
  missingItemIds: string[];
  complete: boolean;
  /** Savings vs the previous (fewer-stop) proposal — only when coverage is identical. */
  savingsVsPrevious: number | null;
  /** Savings vs the best one-stop route — only when coverage is identical. */
  savingsVsOneStop: number | null;
  evidence: EvidenceMix;
  restrictions: { itemId: string; name: string; note: string }[];
  substitutes: { itemId: string; name: string; reasons: string[] }[];
}

export interface StoreCoverage {
  storeId: string;
  storeName: string;
  /** Total for the eligible lines this store can supply. */
  subtotal: number;
  coveredItemIds: string[];
  missingItemIds: string[];
  eligibleCount: number;
  complete: boolean;
  evidence: EvidenceMix;
}

export interface BasketPlan {
  lines: LineAnalysis[];
  eligibleItemIds: string[];
  held: { itemId: string; name: string; reasons: string[] }[];
  storeCoverage: StoreCoverage[];
  proposals: RouteProposal[];
  /** True when at least one route buys every eligible line. */
  hasCompleteRoute: boolean;
  /** Plain-language caveats for every view (tax/travel unknown, sample data…). */
  caveats: string[];
}

export const MAX_STOPS_LIMIT = 3;

// ─── Candidate evaluation (shared eligibility rules) ────────────────────────

function emptyMix(): EvidenceMix {
  return { verified: 0, manual: 0, flyer: 0, unverified: 0, demo: 0 };
}

function offerAttributes(ev: OfferEvidence): string[] {
  const attrs = new Set((ev.attributes ?? []).map((a) => a.toLowerCase()));
  if (ev.productName) for (const a of parseVariantAttributes(ev.productName)) attrs.add(a);
  return [...attrs];
}

function isVerifiedSale(pr: PriceResult, ev: OfferEvidence): boolean {
  if (ev.isSale === true) return true;
  const s = pr.saleInfo;
  return !!s && s.isOnSale && s.unitPriceVsRegular < 0;
}

/**
 * Judge one store's offer for one line. Every exclusion and substitution
 * carries a reason the UI shows verbatim.
 */
export function evaluateCandidate(
  line: BasketLine,
  storeId: string,
  storeName: string,
  pr: PriceResult,
  ctx: PlannerContext,
): Candidate {
  const ev = getEvidence(pr);
  const base: Candidate = {
    storeId,
    storeName,
    verdict: 'exact',
    reasons: [],
    provenance: ev.provenance,
    sourceLabel: ev.sourceLabel,
    productName: ev.productName,
    shelfPrice: pr.price,
    priceBasis: ev.priceBasis ?? 'per_package',
    packageSize: ev.packageSize,
  };
  const exclude = (reason: string): Candidate => ({ ...base, verdict: 'excluded', reasons: [...base.reasons, reason] });

  // Validity, freshness, stock.
  const validity = evaluateValidity(ev, ctx.window, ctx.now);
  if (validity.status === 'excluded') return exclude(validity.reason);
  if (validity.status === 'restricted') base.restriction = validity.note;

  // Channel, branch, currency, membership.
  const channel = ctx.channel ?? 'in_store';
  if (ev.channel && ev.channel !== channel) return exclude(`${ev.channel.replace('_', '-')} price; planning an ${channel.replace('_', '-')} trip`);
  const branch = ctx.branchByStore?.[storeId];
  if (branch && ev.branchId && ev.branchId !== branch) return exclude(`price is for a different branch (${ev.branchId})`);
  const currency = ctx.currency ?? 'CAD';
  if (ev.currency && ev.currency !== currency) return exclude(`price is in ${ev.currency}, not ${currency}`);
  if (ev.membershipRequired) {
    const held = (ctx.memberships ?? []).map((m) => m.toLowerCase());
    if (!held.includes(ev.membershipRequired.toLowerCase())) {
      return exclude(`requires ${ev.membershipRequired} membership (not enabled)`);
    }
  }

  // Product identity and variant requirements.
  if (ev.productName && !productMatches(line.productKey, ev.productName)) {
    return exclude(`offer is for "${ev.productName}"`);
  }
  const attrs = offerAttributes(ev);
  for (const req of line.requirements) {
    if (attrs.includes(req.attr)) continue;
    if (req.exclusive) {
      const conflicting = attrs.find((a) => a !== req.attr && variantGroup(a) === req.group);
      if (conflicting) {
        return exclude(`offer is ${conflicting.toUpperCase()}; list requires ${requirementLabel(req)}`);
      }
    }
    const why = `no evidence the offer is ${requirementLabel(req)}`;
    if (!line.allowSubstitution) return exclude(why);
    base.verdict = 'substitute';
    base.reasons.push(why);
  }

  // Sale-only rule.
  if (line.saleOnly && !isVerifiedSale(pr, ev)) {
    return exclude('sale-only: no verified sale price');
  }

  // Quantity and packs.
  if (!line.quantity) return exclude('quantity unknown');
  const purchase = planPurchase({
    required: line.quantity,
    price: pr.price,
    priceBasis: base.priceBasis,
    packageSize: ev.packageSize,
  });
  if (!purchase.ok) return exclude(purchase.reason);
  if (ev.minPacks && purchase.packs < ev.minPacks) {
    return exclude(`promotion requires buying ${ev.minPacks} packs`);
  }

  return {
    ...base,
    packs: purchase.packs,
    purchased: purchase.purchased,
    lineTotal: purchase.lineTotal,
    purchaseDescription: purchase.description,
  };
}

// ─── Line analysis ──────────────────────────────────────────────────────────

function analyseLine(
  line: BasketLine,
  perStorePrices: Record<string, Record<string, PriceResult>>,
  storeIds: string[],
  storeNameMap: Record<string, string>,
  ctx: PlannerContext,
): LineAnalysis {
  if (line.checked) return { line, status: 'not_buying', reasons: ['already checked off'], candidates: [] };
  if (line.quantitySource === 'zero') return { line, status: 'not_buying', reasons: ['quantity is 0 — not buying'], candidates: [] };

  const candidates: Candidate[] = [];
  for (const sid of storeIds) {
    const pr = perStorePrices[sid]?.[line.itemId];
    if (!pr) continue;
    candidates.push(evaluateCandidate(line, sid, storeNameMap[sid] ?? pr.source?.storeName ?? sid, pr, ctx));
  }

  if (line.quantitySource === 'unknown') {
    return { line, status: 'held', reasons: ['quantity unknown — set a quantity to include it'], candidates };
  }
  if (candidates.length === 0) {
    return { line, status: 'held', reasons: ['no price found at any store'], candidates };
  }
  if (!candidates.some((c) => c.verdict !== 'excluded')) {
    const reasons = candidates.map((c) => `${c.storeName}: ${c.reasons.join('; ')}`);
    return { line, status: 'held', reasons, candidates };
  }
  return { line, status: 'eligible', reasons: [], candidates };
}

// ─── Route optimisation ─────────────────────────────────────────────────────

/** All combinations of `arr` of exactly size k, in lexical order. */
function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      acc.push(arr[i]!);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

/** Deterministic preference between two usable candidates for the same line. */
function betterCandidate(a: Candidate, b: Candidate): boolean {
  if (a.lineTotal! !== b.lineTotal!) return a.lineTotal! < b.lineTotal!;
  if (a.verdict !== b.verdict) return a.verdict === 'exact';
  return a.storeId < b.storeId;
}

interface Evaluated {
  assignments: Assignment[];
  total: number;
  usedStores: string[];
}

function evaluateStoreSet(eligible: LineAnalysis[], storeSet: Set<string>): Evaluated {
  const assignments: Assignment[] = [];
  let total = 0;
  const used = new Set<string>();
  for (const la of eligible) {
    let best: Candidate | null = null;
    for (const c of la.candidates) {
      if (c.verdict === 'excluded' || !storeSet.has(c.storeId)) continue;
      if (!best || betterCandidate(c, best)) best = c;
    }
    if (best) {
      assignments.push({ itemId: la.line.itemId, name: la.line.displayName, candidate: best });
      total += best.lineTotal!;
      used.add(best.storeId);
    }
  }
  return { assignments, total: roundMoney(total), usedStores: [...used].sort() };
}

/** Coverage first, then total, then fewer stores, then store ids. */
function isBetter(a: Evaluated, b: Evaluated): boolean {
  if (a.assignments.length !== b.assignments.length) return a.assignments.length > b.assignments.length;
  if (a.total !== b.total) return a.total < b.total;
  if (a.usedStores.length !== b.usedStores.length) return a.usedStores.length < b.usedStores.length;
  return a.usedStores.join(',') < b.usedStores.join(',');
}

function mixOf(assignments: Assignment[]): EvidenceMix {
  const mix = emptyMix();
  for (const a of assignments) mix[a.candidate.provenance]++;
  return mix;
}

function sameCoverage(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function toProposal(
  k: number,
  ev: Evaluated,
  eligibleIds: string[],
  storeNameMap: Record<string, string>,
): RouteProposal {
  const covered = ev.assignments.map((a) => a.itemId).sort();
  const coveredSet = new Set(covered);
  const stores = ev.usedStores.map((sid) => {
    const mine = ev.assignments.filter((a) => a.candidate.storeId === sid);
    return {
      storeId: sid,
      storeName: storeNameMap[sid] ?? mine[0]?.candidate.storeName ?? sid,
      subtotal: roundMoney(mine.reduce((s, a) => s + a.candidate.lineTotal!, 0)),
      itemIds: mine.map((a) => a.itemId),
    };
  });
  return {
    maxStops: k,
    stores,
    assignments: ev.assignments,
    merchandiseTotal: ev.total,
    coveredItemIds: covered,
    missingItemIds: eligibleIds.filter((id) => !coveredSet.has(id)),
    complete: covered.length === eligibleIds.length,
    savingsVsPrevious: null,
    savingsVsOneStop: null,
    evidence: mixOf(ev.assignments),
    restrictions: ev.assignments
      .filter((a) => a.candidate.restriction)
      .map((a) => ({ itemId: a.itemId, name: a.name, note: `${a.candidate.storeName}: ${a.candidate.restriction}` })),
    substitutes: ev.assignments
      .filter((a) => a.candidate.verdict === 'substitute')
      .map((a) => ({ itemId: a.itemId, name: a.name, reasons: a.candidate.reasons })),
  };
}

/**
 * Plan the basket. `maxStops` is clamped to 1..3. Pure and deterministic for
 * a given (items, prices, ctx).
 */
export function planBasket(
  items: LineSource[],
  perStorePrices: Record<string, Record<string, PriceResult>>,
  storeNameMap: Record<string, string>,
  maxStops: number,
  ctx: PlannerContext,
): BasketPlan {
  const limit = Math.max(1, Math.min(MAX_STOPS_LIMIT, Math.floor(maxStops) || 1));
  const storeIds = Object.keys(perStorePrices).sort();
  const lines = items.map(deriveBasketLine);
  const analyses = lines.map((l) => analyseLine(l, perStorePrices, storeIds, storeNameMap, ctx));
  const eligible = analyses.filter((a) => a.status === 'eligible');
  const eligibleIds = eligible.map((a) => a.line.itemId).sort();

  const held = analyses
    .filter((a) => a.status === 'held')
    .map((a) => ({ itemId: a.line.itemId, name: a.line.displayName, reasons: a.reasons }));

  // Stores that can supply at least one eligible line.
  const usable = storeIds.filter((sid) =>
    eligible.some((a) => a.candidates.some((c) => c.storeId === sid && c.verdict !== 'excluded')),
  );

  const storeCoverage: StoreCoverage[] = usable
    .map((sid) => {
      const ev = evaluateStoreSet(eligible, new Set([sid]));
      const covered = ev.assignments.map((a) => a.itemId);
      const coveredSet = new Set(covered);
      return {
        storeId: sid,
        storeName: storeNameMap[sid] ?? ev.assignments[0]?.candidate.storeName ?? sid,
        subtotal: ev.total,
        coveredItemIds: covered,
        missingItemIds: eligibleIds.filter((id) => !coveredSet.has(id)),
        eligibleCount: eligibleIds.length,
        complete: covered.length === eligibleIds.length,
        evidence: mixOf(ev.assignments),
      };
    })
    // Complete stores first, then more coverage, then cheaper, then id.
    .sort((a, b) =>
      b.coveredItemIds.length - a.coveredItemIds.length ||
      a.subtotal - b.subtotal ||
      (a.storeId < b.storeId ? -1 : 1),
    );

  const proposals: RouteProposal[] = [];
  for (let k = 1; k <= Math.min(limit, usable.length); k++) {
    let best: Evaluated | null = null;
    for (let size = 1; size <= k; size++) {
      for (const combo of combinations(usable, size)) {
        const ev = evaluateStoreSet(eligible, new Set(combo));
        if (!best || isBetter(ev, best)) best = ev;
      }
    }
    if (!best) break;
    const prev = proposals[proposals.length - 1];
    // A larger limit that changes nothing is not a separate route.
    if (prev && sameCoverage(prev.coveredItemIds, best.assignments.map((a) => a.itemId).sort()) && prev.merchandiseTotal === best.total) {
      continue;
    }
    proposals.push(toProposal(k, best, eligibleIds, storeNameMap));
  }

  const oneStop = proposals[0];
  for (let i = 1; i < proposals.length; i++) {
    const p = proposals[i]!;
    const prev = proposals[i - 1]!;
    if (sameCoverage(p.coveredItemIds, prev.coveredItemIds)) {
      p.savingsVsPrevious = roundMoney(prev.merchandiseTotal - p.merchandiseTotal);
    }
    if (oneStop && sameCoverage(p.coveredItemIds, oneStop.coveredItemIds)) {
      p.savingsVsOneStop = roundMoney(oneStop.merchandiseTotal - p.merchandiseTotal);
    }
  }

  const caveats = ['Merchandise only — tax, travel, delivery fees and memberships are not included (unknown, not $0).'];
  const allMix = emptyMix();
  for (const p of proposals) for (const k of Object.keys(allMix) as OfferProvenance[]) allMix[k] += p.evidence[k];
  if (allMix.demo > 0) caveats.push('Some prices are sample data, not real store prices — savings are illustrative only.');
  if (allMix.unverified > 0 || allMix.flyer > 0) caveats.push('Some prices are not verified at your store — check before you go.');
  if (eligibleIds.length > 0 && !proposals.some((p) => p.complete)) {
    caveats.push('No complete comparison is available: no route within the stop limit buys every line.');
  }
  if (held.length > 0) caveats.push(`${held.length} line${held.length === 1 ? ' is' : 's are'} held out of the comparison.`);

  return {
    lines: analyses,
    eligibleItemIds: eligibleIds,
    held,
    storeCoverage,
    proposals,
    hasCompleteRoute: proposals.some((p) => p.complete),
    caveats,
  };
}

/** True when savings for this proposal may be stated as real money. */
export function savingsAreClaimable(p: RouteProposal): boolean {
  return p.complete && p.evidence.demo === 0;
}
