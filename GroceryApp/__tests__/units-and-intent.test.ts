/**
 * Units (pack arithmetic) and list intent (what a line asks for).
 */

import { describe, it, expect } from '@jest/globals';
import { planPurchase, toBase } from '../src/pricing/units';
import { deriveBasketLine, parseVariantAttributes, productKey, productMatches } from '../src/pricing/list-intent';

describe('planPurchase', () => {
  it('fixed packs use ceiling division: 500 g from 340 g bags is two bags', () => {
    const r = planPurchase({ required: { amount: 500, unit: 'g' }, price: 3.49, priceBasis: 'per_package', packageSize: { amount: 340, unit: 'g' } });
    expect(r).toMatchObject({ ok: true, packs: 2, purchased: { amount: 680, unit: 'g' }, lineTotal: 6.98 });
  });

  it('converts within a dimension (kg ↔ g, L ↔ mL, dozen → ea)', () => {
    expect(planPurchase({ required: { amount: 1, unit: 'kg' }, price: 2, priceBasis: 'per_package', packageSize: { amount: 500, unit: 'g' } })).toMatchObject({ ok: true, packs: 2 });
    expect(planPurchase({ required: { amount: 1500, unit: 'mL' }, price: 4, priceBasis: 'per_package', packageSize: { amount: 1, unit: 'L' } })).toMatchObject({ ok: true, packs: 2 });
    expect(planPurchase({ required: { amount: 2, unit: 'dozen' }, price: 4, priceBasis: 'per_package', packageSize: { amount: 12, unit: 'ea' } })).toMatchObject({ ok: true, packs: 2 });
  });

  it('exact multiples do not round up from floating-point noise', () => {
    expect(planPurchase({ required: { amount: 0.3, unit: 'kg' }, price: 1, priceBasis: 'per_package', packageSize: { amount: 0.1, unit: 'kg' } })).toMatchObject({ ok: true, packs: 3 });
  });

  it('weighed produce may be fractional', () => {
    expect(planPurchase({ required: { amount: 750, unit: 'g' }, price: 4.4, priceBasis: 'per_kg' })).toMatchObject({ ok: true, lineTotal: 3.3 });
    expect(planPurchase({ required: { amount: 2, unit: 'lb' }, price: 1.99, priceBasis: 'per_lb' })).toMatchObject({ ok: true, lineTotal: 3.98 });
  });

  it('never converts between count, mass and volume', () => {
    expect(planPurchase({ required: { amount: 6, unit: 'ea' }, price: 4.4, priceBasis: 'per_kg' }).ok).toBe(false);
    expect(planPurchase({ required: { amount: 2, unit: 'L' }, price: 3, priceBasis: 'per_package', packageSize: { amount: 1, unit: 'kg' } }).ok).toBe(false);
    expect(planPurchase({ required: { amount: 2, unit: 'kg' }, price: 3, priceBasis: 'per_package', packageSize: { amount: 6, unit: 'ea' } }).ok).toBe(false);
  });

  it('does not invent a package size for mass or volume', () => {
    const r = planPurchase({ required: { amount: 500, unit: 'g' }, price: 3, priceBasis: 'per_package' });
    expect(r).toEqual({ ok: false, reason: 'package size unknown; cannot tell how many packs make 500 g' });
  });

  it('package words only match the same word', () => {
    expect(planPurchase({ required: { amount: 2, unit: 'bags' }, price: 3, priceBasis: 'per_package', packageSize: { amount: 1, unit: 'bag' } })).toMatchObject({ ok: true, packs: 2 });
    expect(planPurchase({ required: { amount: 1, unit: 'bunch' }, price: 3, priceBasis: 'per_package', packageSize: { amount: 1, unit: 'bag' } }).ok).toBe(false);
  });

  it('zero quantity buys nothing', () => {
    expect(planPurchase({ required: { amount: 0, unit: 'ea' }, price: 3, priceBasis: 'per_package' }).ok).toBe(false);
  });

  it('toBase keeps dimensions apart', () => {
    expect(toBase({ amount: 1, unit: 'lb' })).toMatchObject({ dimension: 'mass' });
    expect(toBase({ amount: 1, unit: 'L' })).toMatchObject({ dimension: 'volume', amount: 1000 });
    expect(toBase({ amount: 1, unit: 'pcs' })).toMatchObject({ dimension: 'count', amount: 1 });
  });
});

describe('list intent', () => {
  it('GREEN grapes requires green; red is a conflicting variant', () => {
    const line = deriveBasketLine({ id: 'g', name: 'GREEN grapes', quantity: 1, unit: 'kg' });
    expect(line.requirements).toEqual([{ attr: 'green', group: 'colour', exclusive: true }]);
    expect(line.productKey).toBe('grape');
    expect(parseVariantAttributes('Red seedless grapes')).toEqual(['red', 'seedless']);
  });

  it('whole lactose-free milk requires both whole and lactose-free', () => {
    const line = deriveBasketLine({ id: 'm', name: 'whole lactose-free milk', quantity: 2, unit: 'L' });
    expect(line.requirements.map((r) => r.attr).sort()).toEqual(['lactose-free', 'whole']);
    expect(line.productKey).toBe('milk');
    expect(parseVariantAttributes('Lactose free 3.25% milk')).toEqual(['whole', 'lactose-free']);
  });

  it('JAMAICAN patties requires jamaican; productKey singularises', () => {
    const line = deriveBasketLine({ id: 'p', name: 'JAMAICAN patties', quantity: 8, unit: 'ea' });
    expect(line.requirements.map((r) => r.attr)).toEqual(['jamaican']);
    expect(line.productKey).toBe('patty');
    expect(productMatches(line.productKey, 'Jamaican beef patties 4 pk')).toBe(true);
    expect(productMatches(line.productKey, 'Beef burgers')).toBe(false);
  });

  it('an unknown ALL-CAPS word is a requirement the offer must evidence', () => {
    const line = deriveBasketLine({ id: 'b', name: 'KIRKLAND almonds', quantity: 1, unit: 'bag' });
    expect(line.requirements).toEqual([{ attr: 'kirkland', group: 'emphasis:kirkland', exclusive: false }]);
  });

  it('sale-only, substitution and store-hint phrases are recognised and removed from notes', () => {
    const line = deriveBasketLine({ id: 'k', name: 'ketchup', quantity: 1, unit: 'bottle', notes: 'sale only; no subs; store hint: Costco; for kids' });
    expect(line.saleOnly).toBe(true);
    expect(line.allowSubstitution).toBe(false);
    expect(line.storeHint).toBe('Costco');
    expect(line.notes).toBe('for kids');
  });

  it('"ketchup (sale only)" as written in a checklist', () => {
    const line = deriveBasketLine({ id: 'k', name: 'ketchup (sale only)', quantity: 1, unit: 'bottle' });
    expect(line.saleOnly).toBe(true);
    expect(line.displayName).toBe('ketchup');
  });

  it('substitutions are off unless the line says otherwise', () => {
    expect(deriveBasketLine({ id: 'a', name: 'GREEN grapes', quantity: 1, unit: 'kg' }).allowSubstitution).toBe(false);
    expect(deriveBasketLine({ id: 'a', name: 'GREEN grapes', quantity: 1, unit: 'kg', notes: 'subs ok' }).allowSubstitution).toBe(true);
  });

  it('productKey strips quantities and variant words', () => {
    expect(productKey('Basmati rice 2 kg')).toBe('basmati rice');
    expect(productMatches('basmati rice', 'Basmati rice 2 kg')).toBe(true);
  });
});
