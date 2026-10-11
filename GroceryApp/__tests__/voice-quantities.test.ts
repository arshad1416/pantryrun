/**
 * Spoken quantities reach the list as amounts the basket can price:
 * leading numbers and number words, fractions, "a couple", "half a dozen",
 * gallons, multipacks, list commands — and no unit means packages (''),
 * which pricing/quantity.ts costs against any package size, where "each"
 * would rule out every packaged product.
 */

import { describe, it, expect } from '@jest/globals';
import { parseVoiceText } from '../src/voice/nlp';
import { parseRequirement } from '../src/pricing/quantity';

const parse = (t: string) => {
  const { name, quantity, unit } = parseVoiceText(t);
  return { name, quantity, unit };
};

describe('voice quantities', () => {
  it.each([
    ['add 2 milk', { name: 'Milk', quantity: 2, unit: '' }],
    ['3 bananas', { name: 'Bananas', quantity: 3, unit: '' }],
    ['2x milk', { name: 'Milk', quantity: 2, unit: '' }],
    ['two apples', { name: 'Apples', quantity: 2, unit: '' }],
    ['twenty four eggs', { name: 'Eggs', quantity: 24, unit: '' }],
    ['half a dozen eggs', { name: 'Eggs', quantity: 6, unit: 'each' }],
    ['a gallon of milk', { name: 'Milk', quantity: 3.785, unit: 'L' }],
    ['one and a half litres of milk', { name: 'Milk', quantity: 1.5, unit: 'L' }],
    ['1 and a half kg of chicken', { name: 'Chicken', quantity: 1.5, unit: 'kg' }],
    ['1/2 lb of ham', { name: 'Ham', quantity: 0.5, unit: 'lb' }],
    ['a couple of avocados', { name: 'Avocados', quantity: 2, unit: '' }],
    ['2 x 355 ml coke', { name: 'Coke', quantity: 710, unit: 'ml' }],
    ['put eggs on the list', { name: 'Eggs', quantity: 1, unit: '' }],
    ['add 2 milk to my shopping list', { name: 'Milk', quantity: 2, unit: '' }],
    ['a banana', { name: 'Banana', quantity: 1, unit: '' }],
  ])('%s', (text, expected) => {
    expect(parse(text)).toEqual(expected);
  });

  it('keeps product words that happen to be fillers', () => {
    expect(parse('a can of soup')).toEqual({ name: 'Soup', quantity: 1, unit: 'can' });
    expect(parse('mac and cheese')).toEqual({ name: 'Mac And Cheese', quantity: 1, unit: '' });
    expect(parse('half and half cream')).toEqual({ name: 'Half And Half Cream', quantity: 1, unit: '' });
  });

  it('numbers that are part of the name stay there', () => {
    expect(parse('2% milk')).toEqual({ name: '2% Milk', quantity: 1, unit: '' });
    expect(parse('7up')).toEqual({ name: '7up', quantity: 1, unit: '' });
  });

  it('an unknown word after a number is the product, not a unit', () => {
    expect(parse('2 bananas organic')).toEqual({ name: 'Bananas Organic', quantity: 2, unit: '' });
  });

  it('a bare item is one package the basket can price', () => {
    const { quantity, unit } = parseVoiceText('milk');
    expect(parseRequirement(quantity, unit)).toEqual({ ok: true, requirement: { kind: 'packages', packages: 1 } });
  });
});
