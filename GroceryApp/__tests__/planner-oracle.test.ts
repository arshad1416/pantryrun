/**
 * Independent exhaustive oracle for the basket planner.
 *
 * The oracle does not enumerate store sets. It enumerates every assignment
 * of each line to one store that sells it (or to "not bought"), keeps those
 * that use at most k distinct stores, and picks the best by coverage, then
 * total. The planner must reach the same coverage and the same total on
 * every random fixture.
 */

import { describe, it, expect } from '@jest/globals';
import { planBasket } from '../src/pricing/basket-planner';
import type { PriceResult } from '../src/pricing/types';
import type { LineSource } from '../src/pricing/list-intent';

const NOW = Date.parse('2026-10-04T16:00:00Z');
const WINDOW = { start: '2026-10-05', end: '2026-10-05' };

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function offer(storeId: string, price: number, pack: number): PriceResult {
  return {
    price,
    unitPrice: price,
    unit: 'ea',
    saleInfo: null,
    source: { adapterId: 'oracle', tier: 'crowd', storeId, storeName: storeId },
    timestamp: NOW,
    confidence: 'recent',
    evidence: { provenance: 'manual', observedAt: NOW, packageSize: { amount: pack, unit: 'ea' } },
  };
}

interface Fixture {
  items: LineSource[];
  prices: Record<string, Record<string, PriceResult>>;
}

function randomFixture(seed: number): Fixture {
  const r = rng(seed);
  const nStores = 2 + Math.floor(r() * 4); // 2..5
  const nItems = 2 + Math.floor(r() * 5); // 2..6
  const stores = Array.from({ length: nStores }, (_, i) => `s${i}`);
  const items: LineSource[] = Array.from({ length: nItems }, (_, i) => ({
    id: `i${i}`,
    name: `item ${i}`,
    quantity: 1 + Math.floor(r() * 5),
    unit: 'ea',
  }));
  const prices: Fixture['prices'] = {};
  for (const s of stores) {
    prices[s] = {};
    for (const it of items) {
      if (r() < 0.65) {
        const price = Math.round((0.5 + r() * 9) * 100) / 100;
        const pack = 1 + Math.floor(r() * 3);
        prices[s]![it.id] = offer(s, price, pack);
      }
    }
  }
  return { items, prices };
}

function lineCost(pr: PriceResult, qty: number): number {
  const pack = pr.evidence!.packageSize!.amount;
  return Math.ceil(qty / pack) * pr.price;
}

function oracle(fx: Fixture, k: number): { covered: number; total: number } {
  const stores = Object.keys(fx.prices);
  const options = fx.items.map((it) => [
    null,
    ...stores.filter((s) => fx.prices[s]![it.id]).map((s) => s),
  ]);
  let best = { covered: -1, total: Infinity };
  const walk = (i: number, used: Set<string>, covered: number, total: number) => {
    if (used.size > k) return;
    if (i === fx.items.length) {
      const t = Math.round(total * 100) / 100;
      if (covered > best.covered || (covered === best.covered && t < best.total)) best = { covered, total: t };
      return;
    }
    for (const s of options[i]!) {
      if (s === null) {
        walk(i + 1, used, covered, total);
      } else {
        const next = new Set(used);
        next.add(s);
        walk(i + 1, next, covered + 1, total + lineCost(fx.prices[s]![fx.items[i]!.id]!, fx.items[i]!.quantity));
      }
    }
  };
  walk(0, new Set(), 0, 0);
  return best;
}

describe('planner agrees with the exhaustive oracle', () => {
  it('on 300 random small fixtures for k = 1, 2, 3', () => {
    let compared = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const fx = randomFixture(seed);
      for (const k of [1, 2, 3]) {
        const plan = planBasket(fx.items, fx.prices, {}, k, { window: WINDOW, now: NOW });
        const expected = oracle(fx, k);
        const last = plan.proposals[plan.proposals.length - 1];
        const got = last
          ? { covered: last.coveredItemIds.length, total: last.merchandiseTotal }
          : { covered: 0, total: 0 };
        expect({ seed, k, ...got }).toEqual({ seed, k, ...expected });
        expect(last ? last.stores.length : 0).toBeLessThanOrEqual(k);
        compared++;
      }
    }
    expect(compared).toBe(900);
  });

  it('never prices a line that no store sells', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const fx = randomFixture(seed);
      const plan = planBasket(fx.items, fx.prices, {}, 3, { window: WINDOW, now: NOW });
      const unsold = fx.items.filter((it) => !Object.values(fx.prices).some((m) => m[it.id])).map((it) => it.id);
      for (const p of plan.proposals) {
        for (const id of unsold) expect(p.coveredItemIds).not.toContain(id);
      }
      for (const id of unsold) expect(plan.held.map((h) => h.itemId)).toContain(id);
    }
  });
});
