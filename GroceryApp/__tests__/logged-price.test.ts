/**
 * Logged prices ("Log Price") — a price someone enters must reach the
 * comparison for the right store, override sample data, take effect when
 * corrected, and never turn the list quantity into a package size.
 */

import { describe, it, expect } from '@jest/globals';
import { buildLoggedPrice, storeIdFromName } from '../src/pricing/logged-price';
import { CrowdsourcedAdapter } from '../src/pricing/crowdsourced';
import { parseRequirement, purchaseFor, type Requirement } from '../src/pricing/quantity';

function req(qty: number, unit?: string): Requirement {
  const r = parseRequirement(qty, unit);
  if (!r.ok) throw new Error(r.reason);
  return r.requirement;
}

function logged(form: Partial<Parameters<typeof buildLoggedPrice>[0]>) {
  const r = buildLoggedPrice({ itemName: 'Milk', itemUnit: 'L', price: '2.49', storeName: 'No Frills', submittedBy: 'me', ...form });
  if (!r.ok) throw new Error(r.error);
  return r.submission;
}

describe('buildLoggedPrice', () => {
  it('uses the adapters’ store id, so the price lands on the existing store', () => {
    expect(storeIdFromName('No Frills')).toBe('no-frills');
    expect(storeIdFromName('A1 Cash & Carry')).toBe('a1-cash-carry');
    expect(logged({ packageSize: '1 L' }).storeId).toBe('no-frills');
  });

  it('records the package size typed, never the list quantity', () => {
    expect(logged({ packageSize: '340 g' })).toMatchObject({ unit: 'g', quantity: 340, pricingBasis: 'package' });
  });

  it('records a per-kg price as a rate', () => {
    expect(logged({ perWeight: 'kg' })).toMatchObject({ unit: 'kg', quantity: 1, pricingBasis: 'measure' });
  });

  it('a counted item needs no size: the price is for one of them', () => {
    expect(logged({ itemName: 'Bananas', itemUnit: 'bunch' })).toMatchObject({ unit: 'bunch', quantity: 1 });
    expect(logged({ itemName: 'Avocados', itemUnit: '' })).toMatchObject({ unit: 'ea', quantity: 1 });
  });

  it('a measured item without a size or per-weight price is rejected, not guessed', () => {
    expect(buildLoggedPrice({ itemName: 'Milk', itemUnit: 'L', price: '2.49', storeName: 'No Frills', submittedBy: 'me' })).toEqual({
      ok: false,
      error: 'Enter the package size (e.g. 2 L or 340 g), or mark the price as per kg / per lb',
    });
  });

  it('rejects malformed input', () => {
    expect(buildLoggedPrice({ itemName: 'x', itemUnit: '', price: '0', storeName: 'A', submittedBy: 'me' }).ok).toBe(false);
    expect(buildLoggedPrice({ itemName: 'x', itemUnit: '', price: '1', storeName: 'A', packageSize: 'big', submittedBy: 'me' }).ok).toBe(false);
  });
});

describe('crowd adapter with logged prices', () => {
  it('a logged price beats the sample row (it used to be averaged away) and is not labelled demo', async () => {
    const adapter = new CrowdsourcedAdapter();
    const sample = await adapter.getPrice('Milk', 'no-frills');
    expect(sample!.isDemo).toBe(true);

    await adapter.submitPrice(logged({ packageSize: '1 L' }));
    const after = (await adapter.getPrice('Milk', 'no-frills'))!;
    expect(after.price).toBe(2.49);
    expect(after.isDemo).toBeUndefined();
    expect(after.packageSize).toBe(1);
  });

  it('correcting a price takes effect: the latest entry wins', async () => {
    const adapter = new CrowdsourcedAdapter();
    await adapter.submitPrice(logged({ itemName: 'Bread', itemUnit: 'loaf', price: '2.99' }));
    await adapter.submitPrice(logged({ itemName: 'Bread', itemUnit: 'loaf', price: '1.99' }));
    expect((await adapter.getPrice('Bread', 'no-frills'))!.price).toBe(1.99);
  });

  it('end to end: 2 L of milk from a logged 1 L price is two cartons', async () => {
    const adapter = new CrowdsourcedAdapter();
    await adapter.submitPrice(logged({ packageSize: '1 L' }));
    const pr = (await adapter.getPrice('Milk', 'no-frills'))!;
    const r = purchaseFor(req(2, 'L'), pr);
    expect(r.ok && r.purchase.costCents).toBe(498);
    expect(r.ok && r.purchase.packages).toBe(2);
  });

  it('HISTORICAL PROBE: the old form stored the list quantity as the package size', async () => {
    // Old submission for a "2 L" list line: { unit: 'L', quantity: 2 } — a
    // price for one 1 L carton was then read as a 2 L package (half price).
    const adapter = new CrowdsourcedAdapter();
    await adapter.submitPrice(logged({ packageSize: '1 L' }));
    expect((await adapter.getPrice('Milk', 'no-frills'))!.packageSize).toBe(1);
  });
});
