/**
 * Manual offers (Log Price) and the wording every price view uses.
 */

import { describe, it, expect } from '@jest/globals';
import { buildManualOffer, storeIdFromName } from '../src/pricing/manual-offer';
import { CrowdsourcedAdapter } from '../src/pricing/crowdsourced';
import { planBasket } from '../src/pricing/basket-planner';
import { itemPriceInfo, savingsStatement, coverageLabel, evidenceLabel, extraStopNote } from '../src/pricing/plan-display';
import { ITEMS, buildPrices, STORE_NAMES, NOW, WINDOW } from './fixtures/pinned-basket';

describe('buildManualOffer', () => {
  it('uses the adapters’ store id so a logged price lands on the existing store', () => {
    expect(storeIdFromName('No Frills')).toBe('no-frills');
    expect(storeIdFromName('A1 Cash & Carry')).toBe('a1-cash-carry');
  });

  it('records package size and sale end as evidence, never the list quantity', () => {
    const r = buildManualOffer({ itemName: 'cheddar', price: '4.79', storeName: 'FreshCo', packageSize: '340 g', saleEnds: '2026-10-07', submittedBy: 'me' });
    expect(r).toEqual({
      ok: true,
      submission: {
        itemName: 'cheddar', storeId: 'freshco', storeName: 'FreshCo', price: 4.79, unit: 'g', quantity: 340, submittedBy: 'me',
        evidence: { packageSize: { amount: 340, unit: 'g' }, priceBasis: 'per_package', validTo: '2026-10-07', isSale: true, channel: 'in_store' },
      },
    });
  });

  it('rejects malformed input with a message', () => {
    expect(buildManualOffer({ itemName: 'x', price: '0', storeName: 'A', submittedBy: 'me' })).toEqual({ ok: false, error: 'Enter a valid price' });
    expect(buildManualOffer({ itemName: 'x', price: '1', storeName: 'A', packageSize: 'big', submittedBy: 'me' }).ok).toBe(false);
    expect(buildManualOffer({ itemName: 'x', price: '1', storeName: 'A', saleEnds: 'Oct 7', submittedBy: 'me' }).ok).toBe(false);
  });

  it('end to end: a logged price changes the plan for that store', async () => {
    const adapter = new CrowdsourcedAdapter();
    const before = await adapter.getPrice('Milk', 'no-frills');
    expect(before!.evidence!.provenance).toBe('demo');
    const r = buildManualOffer({ itemName: 'Milk', price: '2.49', storeName: 'No Frills', packageSize: '1 L', submittedBy: 'me' });
    if (!r.ok) throw new Error(r.error);
    await adapter.submitPrice(r.submission);
    const after = (await adapter.getPrice('Milk', 'no-frills'))!;
    expect(after.price).toBe(2.49);
    expect(after.evidence).toMatchObject({ provenance: 'manual', packageSize: { amount: 1, unit: 'L' } });

    const plan = planBasket([{ id: 'milk', name: 'Milk', quantity: 2, unit: 'L' }], { 'no-frills': { milk: after } }, {}, 1, { window: { start: '2026-10-04', end: '2026-10-04' }, now: Date.now() });
    expect(plan.proposals[0]!.merchandiseTotal).toBe(4.98);
  });
});

describe('plan display wording', () => {
  const plan = planBasket(ITEMS, buildPrices(), STORE_NAMES, 3, { window: WINDOW, now: NOW });
  const [one, two, three] = plan.proposals;

  it('states coverage and the evidence behind a total', () => {
    expect(coverageLabel(2, 10)).toBe('2 of 10 items');
    expect(evidenceLabel(three!.evidence)).toBe('9 entered by you · 1 flyer');
  });

  it('states savings vs the previous route, before tax and travel', () => {
    expect(savingsStatement(one!, undefined)).toBeNull();
    expect(savingsStatement(three!, two)).toBe('Saves $3.91 vs 2 stops, before tax and travel');
  });

  it('weighs an extra stop against an optional per-stop cost without changing the saving', () => {
    expect(extraStopNote(three!, 5)).toBe('Not worth it at $5.00 per stop');
    expect(extraStopNote(three!, 2)).toBe('Worth it if a stop costs you less than $3.91');
    expect(three!.savingsVsPrevious).toBe(3.91);
  });

  it('row price shows the store, packs and restrictions; held lines show why', () => {
    expect(itemPriceInfo(plan, 'cheese', { route: three })).toEqual({ amount: 9.58, caption: 'FreshCo · 2 × 340 g', tone: 'ok' });
    expect(itemPriceInfo(plan, 'milk', { route: three })).toEqual({
      amount: 5.49, caption: 'FreshCo · 1 × 2 L · price valid only through Wed Oct 7', tone: 'warn',
    });
    expect(itemPriceInfo(plan, 'grapes', { storeId: 'freshco' })).toEqual({
      amount: null, caption: 'offer is RED; list requires GREEN', tone: 'held',
    });
    expect(itemPriceInfo(plan, 'ketchup', {})).toEqual({ amount: null, caption: 'held: Food Basics: offer ended Sat Oct 3', tone: 'held' });
    expect(itemPriceInfo(plan, 'napkins', {})).toBeNull();
  });
});
