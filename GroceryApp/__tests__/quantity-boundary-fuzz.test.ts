import type { PriceResult } from '../src/pricing/types';
import { purchaseFor, parseRequirement, parseUnit } from '../src/pricing/quantity';

describe('quantity input boundary fuzz', () => {
  it.each(Object.getOwnPropertyNames(Object.prototype))('rejects inherited unit name %s', (key) => {
    expect(parseUnit(key)).toBeNull();
    expect(parseRequirement(2, key)).toEqual({ ok: false, reason: 'unit_unknown' });
  });

  it('rejects finite quantities whose unit conversion overflows', () => {
    expect(parseRequirement(Number.MAX_VALUE, 'kg')).toEqual({ ok: false, reason: 'quantity_invalid' });
    expect(parseRequirement(Number.MAX_VALUE, 'L')).toEqual({ ok: false, reason: 'quantity_invalid' });
  });

  it('never accepts non-finite converted requirements across exponent boundaries', () => {
    for (const unit of ['kg', 'g', 'lb', 'oz', 'L', 'mL', 'dozen', 'each']) {
      for (let exponent = -1074; exponent <= 1024; exponent++) {
        const qty = 2 ** exponent;
        const result = parseRequirement(qty, unit);
        if (result.ok && result.requirement.kind === 'amount') {
          expect(Number.isFinite(result.requirement.base)).toBe(true);
          expect(result.requirement.base).toBeGreaterThan(0);
        }
      }
    }
  });
});

// The epsilon used for whole-package rounding must not erase small positive
// user requirements (including an amount underflowing during division).
describe('tiny positive quantities', () => {
  it.each([Number.MIN_VALUE, 1e-15, 1e-12, 1e-10])('buys one package, never zero, for %s', (qty) => {
    for (const unit of ['bags', 'each', 'g']) {
      const requirement = parseRequirement(qty, unit);
      if (!requirement.ok) throw new Error(requirement.reason);
      const offer = { price: 2, unit: unit === 'g' ? 'kg' : unit, packageSize: 1 } as PriceResult;
      const result = purchaseFor(requirement.requirement, offer);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.purchase.packages).toBe(1);
        expect(result.purchase.costCents).toBe(200);
      }
    }
  });
});
