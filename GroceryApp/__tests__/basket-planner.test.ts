/**
 * Basket planner — corrected-behaviour tests against the pinned fixture.
 *
 * Exit gates covered here:
 *  - Fortinos $7.88 is visibly a 2-of-10 subtotal and cannot win.
 *  - An incomplete route never outranks a complete one by omitting items.
 *  - A cheaper RED grape offer cannot satisfy GREEN grapes.
 *  - Two stops $77.20, three stops $73.29, same ten lines, ketchup held,
 *    extra stop saves $3.91 before tax and travel.
 *  - Advancing past a sale's end invalidates it without any list edit.
 *  - Editing a relevant price changes the plan and savings.
 */

import { describe, it, expect } from '@jest/globals';
import { planBasket, evaluateCandidate, savingsAreClaimable, type PlannerContext } from '../src/pricing/basket-planner';
import { deriveBasketLine } from '../src/pricing/list-intent';
import type { PriceResult } from '../src/pricing/types';
import { ITEMS, buildPrices, STORE_NAMES, NOW, WINDOW } from './fixtures/pinned-basket';

const ctx: PlannerContext = { window: WINDOW, now: NOW };

function plan(maxStops = 3, prices = buildPrices(), c: PlannerContext = ctx, items = ITEMS) {
  return planBasket(items, prices, STORE_NAMES, maxStops, c);
}

const ELIGIBLE = ['bananas', 'bread', 'cheese', 'chicken', 'eggs', 'grapes', 'milk', 'patties', 'rice', 'yogurt'];

describe('pinned fixture — route arithmetic', () => {
  const p = plan();

  it('compares exactly ten eligible lines; ketchup is held, napkins (checked) are not bought', () => {
    expect(p.eligibleItemIds).toEqual(ELIGIBLE);
    expect(p.held.map((h) => h.itemId)).toEqual(['ketchup']);
    expect(p.held[0]!.reasons).toEqual([
      'Food Basics: offer ended Sat Oct 3',
      'FreshCo: sale-only: no verified sale price',
      'No Frills: sale-only: no verified sale price',
    ]);
    const napkins = p.lines.find((l) => l.line.itemId === 'napkins')!;
    expect(napkins.status).toBe('not_buying');
    expect(napkins.reasons).toEqual(['already checked off']);
  });

  it('one stop $85.76, two stops $77.20, three stops $73.29 — all covering the same ten lines', () => {
    expect(p.proposals.map((x) => x.merchandiseTotal)).toEqual([85.76, 77.2, 73.29]);
    expect(p.proposals.map((x) => x.stores.map((s) => s.storeId))).toEqual([
      ['no-frills'],
      ['food-basics', 'no-frills'],
      ['food-basics', 'freshco', 'no-frills'],
    ]);
    for (const x of p.proposals) {
      expect(x.coveredItemIds).toEqual(ELIGIBLE);
      expect(x.complete).toBe(true);
      expect(x.missingItemIds).toEqual([]);
    }
  });

  it('the third stop saves $3.91 before tax and travel, stated vs the two-stop route', () => {
    expect(p.proposals[2]!.savingsVsPrevious).toBe(3.91);
    expect(p.proposals[1]!.savingsVsOneStop).toBe(8.56);
    expect(p.caveats[0]).toMatch(/tax, travel, delivery fees and memberships are not included/);
  });

  it('stop subtotals add up to the route total', () => {
    for (const x of p.proposals) {
      const sum = Math.round(x.stores.reduce((s, st) => s + st.subtotal, 0) * 100) / 100;
      expect(sum).toBe(x.merchandiseTotal);
    }
  });

  it('a 2-stop limit never returns a 3-store route', () => {
    const two = plan(2);
    expect(two.proposals.map((x) => x.stores.length)).toEqual([1, 2]);
    expect(two.proposals[1]!.merchandiseTotal).toBe(77.2);
  });

  it('pack arithmetic: 500 g of cheese from 340 g packs is 2 packs; 8 patties from 4-packs is 2 packs; grapes by weight', () => {
    const three = p.proposals[2]!;
    const byItem = Object.fromEntries(three.assignments.map((a) => [a.itemId, a.candidate]));
    expect(byItem.cheese!.packs).toBe(2);
    expect(byItem.cheese!.purchased).toEqual({ amount: 680, unit: 'g' });
    expect(byItem.cheese!.lineTotal).toBe(9.58);
    expect(byItem.patties!.packs).toBe(2);
    expect(byItem.patties!.lineTotal).toBe(12.98);
    expect(byItem.grapes!.lineTotal).toBe(5.94); // 1.5 kg × $3.96/kg
    expect(byItem.grapes!.storeId).toBe('food-basics');
  });
});

describe('coverage is disclosed and decides ranking', () => {
  const p = plan();

  it('Fortinos $7.88 is a two-of-ten subtotal, ranked below complete stores', () => {
    const fortinos = p.storeCoverage.find((s) => s.storeId === 'fortinos')!;
    expect(fortinos.subtotal).toBe(7.88);
    expect(fortinos.coveredItemIds).toEqual(['bananas', 'bread']);
    expect(fortinos.eligibleCount).toBe(10);
    expect(fortinos.complete).toBe(false);
    expect(fortinos.missingItemIds).toHaveLength(8);
    expect(p.storeCoverage[0]!.storeId).toBe('no-frills');
    expect(p.storeCoverage[0]!.complete).toBe(true);
    expect(p.storeCoverage[p.storeCoverage.length - 1]!.storeId).toBe('fortinos');
  });

  it('FB + FreshCo ($60.31, 9 lines) cannot outrank NF + FB ($77.20, 10 lines)', () => {
    const two = plan(2);
    expect(two.proposals[1]!.stores.map((s) => s.storeId)).toEqual(['food-basics', 'no-frills']);
  });

  it('with no complete route available, the plan says so, lists what is missing and claims no savings', () => {
    const prices = buildPrices();
    delete prices['no-frills']!.eggs; // now no single store sells all ten lines
    const p = plan(1, prices);
    expect(p.hasCompleteRoute).toBe(false);
    expect(p.caveats).toContain('No complete comparison is available: no route within the stop limit buys every line.');
    const only = p.proposals[0]!;
    expect(only.complete).toBe(false);
    // NF (no eggs) and FB (no JAMAICAN patties) both cover 9 of 10; FB is cheaper.
    expect(only.stores.map((s) => s.storeId)).toEqual(['food-basics']);
    expect(only.missingItemIds).toEqual(['patties']);
    expect(savingsAreClaimable(only)).toBe(false);
  });

  it('an item no store can supply is held with its reasons, and the rest stays comparable', () => {
    const prices = buildPrices();
    delete prices['no-frills']!.patties; // nobody sells JAMAICAN patties now
    const p = plan(3, prices);
    expect(p.held.find((h) => h.itemId === 'patties')!.reasons).toEqual([
      'Food Basics: no evidence the offer is JAMAICAN',
    ]);
    expect(p.eligibleItemIds).not.toContain('patties');
    expect(p.hasCompleteRoute).toBe(true);
  });

  it('savings are only stated between routes covering the same lines', () => {
    const prices = buildPrices();
    delete prices['no-frills']!.eggs; // NF no longer complete; FB still sells eggs
    const p2 = plan(3, prices);
    const one = p2.proposals[0]!;
    const two = p2.proposals[1]!;
    expect(one.complete).toBe(false);
    expect(two.complete).toBe(true);
    expect(two.savingsVsOneStop).toBeNull();
    expect(two.savingsVsPrevious).toBeNull();
  });
});

describe('variants and hard constraints', () => {
  it('a cheaper RED grape offer cannot satisfy GREEN grapes', () => {
    const p = plan();
    const grapes = p.lines.find((l) => l.line.itemId === 'grapes')!;
    const fc = grapes.candidates.find((c) => c.storeId === 'freshco')!;
    expect(fc.verdict).toBe('excluded');
    expect(fc.reasons).toEqual(['offer is RED; list requires GREEN']);
    for (const x of p.proposals) {
      expect(x.assignments.find((a) => a.itemId === 'grapes')!.candidate.storeId).not.toBe('freshco');
    }
  });

  it('a candidate with no evidence for JAMAICAN is not an exact match', () => {
    const p = plan();
    const patties = p.lines.find((l) => l.line.itemId === 'patties')!;
    const fb = patties.candidates.find((c) => c.storeId === 'food-basics')!;
    expect(fb.verdict).toBe('excluded');
    expect(fb.reasons).toEqual(['no evidence the offer is JAMAICAN']);
  });

  it('with substitutions allowed, an unevidenced offer is a labelled substitute, never "exact"', () => {
    const items = ITEMS.map((i) => (i.id === 'patties' ? { ...i, notes: 'subs ok' } : i));
    const p = plan(3, buildPrices(), ctx, items);
    const fb = p.lines.find((l) => l.line.itemId === 'patties')!.candidates.find((c) => c.storeId === 'food-basics')!;
    expect(fb.verdict).toBe('substitute');
    const sub = p.proposals.flatMap((x) => x.substitutes).find((s) => s.itemId === 'patties');
    expect(sub?.reasons).toEqual(['no evidence the offer is JAMAICAN']);
  });

  it('"for kids" stays a note and adds no requirement', () => {
    const line = deriveBasketLine(ITEMS.find((i) => i.id === 'yogurt')!);
    expect(line.notes).toBe('for kids');
    expect(line.requirements).toEqual([]);
  });

  it('a membership price is excluded until the membership is enabled', () => {
    const p = plan();
    const cheese = p.lines.find((l) => l.line.itemId === 'cheese')!;
    expect(cheese.candidates.find((c) => c.storeId === 'costco')!.reasons).toEqual([
      'requires Costco membership (not enabled)',
    ]);
    const withCostco = plan(3, buildPrices(), { ...ctx, memberships: ['Costco'] });
    const c2 = withCostco.lines.find((l) => l.line.itemId === 'cheese')!.candidates.find((c) => c.storeId === 'costco')!;
    expect(c2.verdict).toBe('exact');
    expect(c2.packs).toBe(1);
  });
});

describe('validity against the shopping date', () => {
  it('a sale that ends mid-window is usable but carries the restriction', () => {
    const three = plan().proposals[2]!;
    expect(three.restrictions).toEqual([
      { itemId: 'milk', name: 'whole lactose-free milk', note: 'FreshCo: price valid only through Wed Oct 7' },
    ]);
  });

  it('advancing the shopping date past expiry invalidates the offer with no list edit', () => {
    const later = plan(3, buildPrices(), { window: { start: '2026-10-08', end: '2026-10-10' }, now: NOW });
    const milk = later.lines.find((l) => l.line.itemId === 'milk')!;
    expect(milk.candidates.find((c) => c.storeId === 'freshco')!.reasons).toEqual(['offer ended Wed Oct 7']);
    const three = later.proposals[later.proposals.length - 1]!;
    expect(three.assignments.find((a) => a.itemId === 'milk')!.candidate.storeId).toBe('food-basics');
    expect(three.merchandiseTotal).toBe(74.09); // 73.29 − 5.49 + 6.29
  });

  it('stale, withdrawn, out-of-stock, wrong-channel, wrong-branch and wrong-currency offers fail closed with reasons', () => {
    const line = deriveBasketLine({ id: 'eggs', name: 'eggs', quantity: 12, unit: 'ea' });
    const base = buildPrices()['food-basics']!.eggs!;
    const withEv = (ev: Partial<NonNullable<PriceResult['evidence']>>): PriceResult => ({
      ...base,
      evidence: { ...base.evidence!, ...ev },
    });
    const c = { ...ctx, branchByStore: { 'food-basics': 'fb-0412' } };
    const reasons = (pr: PriceResult) => evaluateCandidate(line, 'food-basics', 'Food Basics', pr, c).reasons;
    expect(reasons(withEv({ observedAt: NOW - 20 * 86_400_000 }))).toEqual(['price is 20 days old (stale)']);
    expect(reasons(withEv({ withdrawn: true }))).toEqual(['offer withdrawn by the source']);
    expect(reasons(withEv({ stockStatus: 'out_of_stock' }))).toEqual(['out of stock']);
    expect(reasons(withEv({ channel: 'online' }))).toEqual(['online price; planning an in-store trip']);
    expect(reasons(withEv({ branchId: 'fb-9999' }))).toEqual(['price is for a different branch (fb-9999)']);
    expect(reasons(withEv({ currency: 'USD' }))).toEqual(['price is in USD, not CAD']);
    expect(reasons(withEv({ validFrom: '2026-10-12' }))).toEqual(['offer starts Mon Oct 12, after your shopping window']);
  });

  it('a verified sale satisfies a sale-only line', () => {
    const prices = buildPrices();
    prices.freshco!.ketchup = {
      ...prices.freshco!.ketchup!,
      price: 2.99,
      evidence: { ...prices.freshco!.ketchup!.evidence!, isSale: true, validTo: '2026-10-10' },
    };
    const p = plan(3, prices);
    expect(p.held.map((h) => h.itemId)).toEqual([]);
    expect(p.eligibleItemIds).toContain('ketchup');
  });
});

describe('quantities', () => {
  it('zero quantity means no purchase, not one', () => {
    const items = ITEMS.map((i) => (i.id === 'eggs' ? { ...i, quantity: 0 } : i));
    const p = plan(3, buildPrices(), ctx, items);
    const eggs = p.lines.find((l) => l.line.itemId === 'eggs')!;
    expect(eggs.status).toBe('not_buying');
    expect(eggs.reasons).toEqual(['quantity is 0 — not buying']);
    expect(p.eligibleItemIds).not.toContain('eggs');
  });

  it('unknown quantity is held, never priced', () => {
    const items = ITEMS.map((i) => (i.id === 'rice' ? { ...i, quantity: Number.NaN } : i));
    const p = plan(3, buildPrices(), ctx, items);
    expect(p.held.find((h) => h.itemId === 'rice')!.reasons).toEqual(['quantity unknown — set a quantity to include it']);
  });

  it('a missing unit is a labelled planning assumption', () => {
    const line = deriveBasketLine({ id: 'x', name: 'avocados', quantity: 3, unit: '' });
    expect(line.quantitySource).toBe('assumed');
    expect(line.quantity).toEqual({ amount: 3, unit: 'ea' });
  });

  it('count against a by-weight price is incompatible, not guessed', () => {
    const items = ITEMS.map((i) => (i.id === 'chicken' ? { ...i, quantity: 6, unit: 'ea' } : i));
    const p = plan(3, buildPrices(), ctx, items);
    const chicken = p.held.find((h) => h.itemId === 'chicken')!;
    expect(chicken.reasons[0]).toMatch(/sold by weight; the list asks for 6 ea and the weight of that is unknown/);
  });
});

describe('edits change the plan', () => {
  it('editing a relevant price changes totals and savings immediately', () => {
    const prices = buildPrices();
    prices.freshco!.chicken = { ...prices.freshco!.chicken!, price: 8.93 };
    const p = plan(3, prices);
    expect(p.proposals[2]!.merchandiseTotal).toBe(71.29); // 73.29 − 2 kg × $1.00
    // The cheaper chicken also makes NF + FreshCo the best two-stop route.
    expect(p.proposals[1]!.stores.map((s) => s.storeId)).toEqual(['freshco', 'no-frills']);
    expect(p.proposals[1]!.merchandiseTotal).toBe(76.35);
    expect(p.proposals[2]!.savingsVsPrevious).toBe(5.06);
  });

  it('a removed offer does not survive in the plan', () => {
    const prices = buildPrices();
    delete prices.freshco;
    const p = plan(3, prices);
    expect(p.proposals.flatMap((x) => x.stores.map((s) => s.storeId))).not.toContain('freshco');
    expect(p.proposals[p.proposals.length - 1]!.merchandiseTotal).toBe(77.2);
  });

  it('is deterministic: same input, same output', () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(plan()));
  });
});

describe('evidence mix', () => {
  it('sample (demo) prices never back a claimable saving', () => {
    const prices = buildPrices();
    for (const store of Object.values(prices)) {
      for (const pr of Object.values(store)) pr.evidence = { ...pr.evidence!, provenance: 'demo' };
    }
    const p = plan(3, prices);
    expect(p.proposals[2]!.evidence.demo).toBe(10);
    expect(savingsAreClaimable(p.proposals[2]!)).toBe(false);
    expect(p.caveats).toContain('Some prices are sample data, not real store prices — savings are illustrative only.');
  });
});
