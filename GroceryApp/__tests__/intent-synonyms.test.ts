/**
 * Intent follow-ups to #7: retailer synonyms and "for …" purpose phrases.
 *
 * Run: npx jest __tests__/intent-synonyms.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import { checkVariant, parseItemIntent } from '../src/pricing/intent';

describe('retailer synonyms', () => {
  it('Mini Carrots (Fortinos\' listing) are baby carrots, both ways', () => {
    expect(checkVariant(parseItemIntent({ name: 'Baby carrots' }), 'Mini Carrots 340 g')).toBe('match');
    expect(checkVariant(parseItemIntent({ name: 'mini carrots' }), 'Baby-Carrots')).toBe('match');
  });

  it('"mini" alone is not a synonym, and plain carrots are not baby carrots', () => {
    const intent = parseItemIntent({ name: 'baby carrots' });
    expect(checkVariant(intent, 'Mini Pretzels')).toBe('mismatch');
    expect(checkVariant(intent, 'Carrots 2 lb')).toBe('mismatch');
  });
});

describe('purpose phrases', () => {
  it('"for kids" is not a product requirement; garlic stays hard', () => {
    const intent = parseItemIntent({ name: 'Garlic mayo for kids' });
    expect(intent.requiredTokens).toEqual(['garlic', 'mayo']);
    expect(intent.hardAttributes).toEqual(['garlic']);
    expect(checkVariant(intent, 'Garlic Mayonnaise 300 mL')).toBe('match');
    expect(checkVariant(intent, 'Mayonnaise 300 mL')).toBe('mismatch');
  });

  it('a name without a trailing "for" phrase is unchanged', () => {
    expect(parseItemIntent({ name: 'Formula milk' }).requiredTokens).toEqual(['formula', 'milk']);
  });
});
