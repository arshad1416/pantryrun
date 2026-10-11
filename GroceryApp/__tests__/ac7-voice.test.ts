/**
 * Acceptance Test AC-7: Voice Subsystem
 *
 * Tests the NLP parser (parseVoiceText) extensively with all example patterns,
 * edge cases, filler word stripping, unit aliases, and case insensitivity.
 *
 * Run: npx jest __tests__/ac7-voice.test.ts
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { parseVoiceText } from '../src/voice/nlp';
import { signRequest, verifySignature, buildWebhookUrl } from '../src/voice/ifttt';
import type { ParsedItem } from '../src/voice/types';

// Provide the IFTTT secret for tests (matches the pre-removal default)
beforeAll(() => {
  process.env.IFTTT_WEBHOOK_SECRET = 'groceryapp-ifttt-secret-phase2';
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function assertItem(
  actual: ParsedItem,
  expected: Partial<ParsedItem>,
): void {
  expect(actual.name).toBe(expected.name);
  expect(actual.quantity).toBe(expected.quantity);
  expect(actual.unit).toBe(expected.unit);
  if (expected.confidence !== undefined) {
    expect(actual.confidence).toBeGreaterThanOrEqual(expected.confidence - 0.05);
    expect(actual.confidence).toBeLessThanOrEqual(expected.confidence + 0.05);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AC-7: Voice Subsystem — NLP Parser', () => {
  // ── Basic Patterns ──────────────────────────────────────────────────────

  describe('Basic Patterns', () => {
    it('parses "2% milk x2" → name:"2% Milk", qty:2, unit:"" (packages)', () => {
      const result = parseVoiceText('2% milk x2');
      assertItem(result, { name: '2% Milk', quantity: 2, unit: '' });
    });

    it('parses "half a kilo of chicken breast" → qty:0.5, unit:"kg"', () => {
      const result = parseVoiceText('half a kilo of chicken breast');
      assertItem(result, {
        name: 'Chicken Breast',
        quantity: 0.5,
        unit: 'kg',
      });
    });

    it('parses "a dozen eggs" → qty:12, unit:"each"', () => {
      const result = parseVoiceText('a dozen eggs');
      assertItem(result, { name: 'Eggs', quantity: 12, unit: 'each' });
    });

    it('parses "bananas" → fallback: qty:1, unit:"" (packages)', () => {
      const result = parseVoiceText('bananas');
      assertItem(result, { name: 'Bananas', quantity: 1, unit: '' });
    });

    it('parses "1kg of rice" → qty:1, unit:"kg"', () => {
      const result = parseVoiceText('1kg of rice');
      assertItem(result, { name: 'Rice', quantity: 1, unit: 'kg' });
    });

    it('parses "2 litres of milk" → qty:2, unit:"L"', () => {
      const result = parseVoiceText('2 litres of milk');
      assertItem(result, { name: 'Milk', quantity: 2, unit: 'L' });
    });

    it('parses "organic valley 2% milk x2 please" → strips fillers', () => {
      const result = parseVoiceText('organic valley 2% milk x2 please');
      assertItem(result, {
        name: 'Organic Valley 2% Milk',
        quantity: 2,
        unit: '',
      });
    });

    it('parses "add milk" → strips "add"', () => {
      const result = parseVoiceText('add milk');
      assertItem(result, { name: 'Milk', quantity: 1, unit: '' });
    });
  });

  // ── Quantity Patterns ───────────────────────────────────────────────────

  describe('Quantity patterns', () => {
    it('parses "x3" suffix: "apples x3"', () => {
      const result = parseVoiceText('apples x3');
      assertItem(result, { name: 'Apples', quantity: 3, unit: '' });
    });

    it('parses decimal "x1.5": "chicken x1.5"', () => {
      const result = parseVoiceText('chicken x1.5');
      assertItem(result, { name: 'Chicken', quantity: 1.5, unit: '' });
    });

    it('parses "2 kg of potatoes"', () => {
      const result = parseVoiceText('2 kg of potatoes');
      assertItem(result, { name: 'Potatoes', quantity: 2, unit: 'kg' });
    });

    it('parses "500g of cheese"', () => {
      const result = parseVoiceText('500g of cheese');
      assertItem(result, { name: 'Cheese', quantity: 500, unit: 'g' });
    });

    it('parses "3 lbs of apples"', () => {
      const result = parseVoiceText('3 lbs of apples');
      assertItem(result, { name: 'Apples', quantity: 3, unit: 'lb' });
    });

    it('parses "2L of milk" (compact unit + of)', () => {
      const result = parseVoiceText('2L of milk');
      assertItem(result, { name: 'Milk', quantity: 2, unit: 'L' });
    });

    it('parses "2 lb rice" (no "of")', () => {
      const result = parseVoiceText('2 lb rice');
      assertItem(result, { name: 'Rice', quantity: 2, unit: 'lb' });
    });
  });

  // ── Unit Aliases ────────────────────────────────────────────────────────

  describe('Unit aliases', () => {
    it('"kilo" → "kg"', () => {
      const result = parseVoiceText('half a kilo of flour');
      assertItem(result, { name: 'Flour', quantity: 0.5, unit: 'kg' });
    });

    it('"litre" → "L"', () => {
      const result = parseVoiceText('1 litre of juice');
      assertItem(result, { name: 'Juice', quantity: 1, unit: 'L' });
    });

    it('"liter" → "L"', () => {
      const result = parseVoiceText('2 liters of water');
      assertItem(result, { name: 'Water', quantity: 2, unit: 'L' });
    });

    it('"dozen" as word quantity → multiplier 12', () => {
      const result = parseVoiceText('a dozen cookies');
      assertItem(result, { name: 'Cookies', quantity: 12, unit: 'each' });
    });

    it('"dozen" as unit → multiplier 12 in "N dozen of X" → qty:24, unit:"each"', () => {
      const result = parseVoiceText('2 dozen of muffins');
      // "dozen" has multiplier 12, so 2 * 12 = 24 items
      assertItem(result, { name: 'Muffins', quantity: 24, unit: 'each' });
    });

    it('"pound" → "lb"', () => {
      const result = parseVoiceText('3 pounds of beef');
      assertItem(result, { name: 'Beef', quantity: 3, unit: 'lb' });
    });

    it('"ounce" → "oz"', () => {
      const result = parseVoiceText('8 ounces of cheese');
      assertItem(result, { name: 'Cheese', quantity: 8, unit: 'oz' });
    });
  });

  // ── Filler Word Stripping ───────────────────────────────────────────────

  describe('Filler word stripping', () => {
    it('strips leading "please"', () => {
      const result = parseVoiceText('please add milk');
      assertItem(result, { name: 'Milk', quantity: 1, unit: '' });
    });

    it('strips "can I get" prefix', () => {
      const result = parseVoiceText('can I get 2% milk x2');
      assertItem(result, {
        name: '2% Milk',
        quantity: 2,
        unit: '',
      });
    });

    it('strips "I need" prefix', () => {
      const result = parseVoiceText('I need a dozen eggs');
      assertItem(result, { name: 'Eggs', quantity: 12, unit: 'each' });
    });

    it('strips "I want" prefix', () => {
      const result = parseVoiceText('I want half a kilo of chicken');
      assertItem(result, {
        name: 'Chicken',
        quantity: 0.5,
        unit: 'kg',
      });
    });

    it('strips "can i have" prefix', () => {
      const result = parseVoiceText('can i have 2 litres of milk');
      assertItem(result, { name: 'Milk', quantity: 2, unit: 'L' });
    });

    it('strips trailing "please"', () => {
      const result = parseVoiceText('add milk please');
      assertItem(result, { name: 'Milk', quantity: 1, unit: '' });
    });

    it('strips "we need" prefix', () => {
      const result = parseVoiceText('we need bananas');
      assertItem(result, { name: 'Bananas', quantity: 1, unit: '' });
    });

    it('strips "i would like to get" prefix', () => {
      const result = parseVoiceText('i would like to get 2% milk x2');
      assertItem(result, {
        name: '2% Milk',
        quantity: 2,
        unit: '',
      });
    });
  });

  // ── Case Insensitivity ──────────────────────────────────────────────────

  describe('Case insensitivity', () => {
    it('handles UPPERCASE: "2 LITRES OF MILK"', () => {
      const result = parseVoiceText('2 LITRES OF MILK');
      assertItem(result, { name: 'Milk', quantity: 2, unit: 'L' });
    });

    it('handles Mixed Case: "Half A Kilo Of Chicken"', () => {
      const result = parseVoiceText('Half A Kilo Of Chicken');
      assertItem(result, {
        name: 'Chicken',
        quantity: 0.5,
        unit: 'kg',
      });
    });

    it('handles Title Case input: "A Dozen Eggs"', () => {
      const result = parseVoiceText('A Dozen Eggs');
      assertItem(result, { name: 'Eggs', quantity: 12, unit: 'each' });
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('empty string returns name="" qty=1 confidence=0', () => {
      const result = parseVoiceText('');
      expect(result.name).toBe('');
      expect(result.quantity).toBe(1);
      expect(result.unit).toBe('');
      expect(result.confidence).toBe(0);
    });

    it('whitespace-only string returns fallback', () => {
      const result = parseVoiceText('   ');
      expect(result.name).toBe('');
      expect(result.quantity).toBe(1);
      expect(result.confidence).toBe(0);
    });

    it('special characters in item name', () => {
      const result = parseVoiceText('Coca-Cola x2');
      assertItem(result, { name: 'Coca-Cola', quantity: 2, unit: '' });
    });

    it('item name with numbers: "2% milk"', () => {
      const result = parseVoiceText('2% milk');
      assertItem(result, { name: '2% Milk', quantity: 1, unit: '' });
    });

    it('very long item name', () => {
      const longName = 'organic grass-fed whole chicken with giblets x1';
      const result = parseVoiceText(longName);
      expect(result.name.length).toBeGreaterThan(0);
      expect(result.quantity).toBe(1);
    });

    it('item name with apostrophe', () => {
      const result = parseVoiceText("Ben & Jerry's ice cream");
      // titleCase preserves the original casing — 's stays lowercase
      expect(result.name).toBe("Ben & Jerry's Ice Cream");
      expect(result.quantity).toBe(1);
      expect(result.unit).toBe('');
    });

    it('item name with commas', () => {
      const result = parseVoiceText('organic, free-range eggs x2');
      assertItem(result, {
        name: 'Organic, Free-Range Eggs',
        quantity: 2,
        unit: '',
      });
    });

    it('only filler words returns fallback on blank', () => {
      const result = parseVoiceText('add please');
      // After stripping fillers, nothing left → should use cleaned (empty)
      // Which falls back to... let's trace: stripFillers("add please") → ""
      // cleaned is empty, so working = raw = "add please"
      expect(result.name).toBe('Add Please');
      expect(result.quantity).toBe(1);
    });

    it('only filler plus "xN" — falls back to raw', () => {
      const result = parseVoiceText('add please x2');
      // Fillers stripped → "x2" which doesn't match xPattern (needs space before x)
      // Falls through to fallback: name="X2", qty=1
      expect(result.name).toBe('X2');
      expect(result.quantity).toBe(1);
      expect(result.unit).toBe('');
    });
  });

  // ── Natural Language Patterns ───────────────────────────────────────────

  describe('Natural language patterns', () => {
    it('"a bunch of bananas" → qty:1, unit:"bunch"', () => {
      const result = parseVoiceText('a bunch of bananas');
      assertItem(result, { name: 'Bananas', quantity: 1, unit: 'bunch' });
    });

    it('"a loaf of bread" → qty:1, unit:"loaf"', () => {
      const result = parseVoiceText('a loaf of bread');
      // "loaf" is a recognized unit alias → name=Bread, qty=1, unit=loaf
      expect(result.name).toBe('Bread');
      expect(result.quantity).toBe(1);
      expect(result.unit).toBe('loaf');
    });

    it('"a bag of apples" → qty:1, unit:"bag"', () => {
      const result = parseVoiceText('a bag of apples');
      assertItem(result, { name: 'Apples', quantity: 1, unit: 'bag' });
    });

    it('"six bottles of water" → qty:6, unit:"bottle"', () => {
      const result = parseVoiceText('six bottles of water');
      assertItem(result, { name: 'Water', quantity: 6, unit: 'bottle' });
    });

    it('"2 cans of soup" → qty:2, unit:"can"', () => {
      const result = parseVoiceText('2 cans of soup');
      assertItem(result, { name: 'Soup', quantity: 2, unit: 'can' });
    });

    it('"three bags of frozen veggies" → qty:3, unit:"bag"', () => {
      const result = parseVoiceText('three bags of frozen veggies');
      assertItem(result, {
        name: 'Frozen Veggies',
        quantity: 3,
        unit: 'bag',
      });
    });

    it('"1 jar of pasta sauce" → qty:1, unit:"jar"', () => {
      const result = parseVoiceText('1 jar of pasta sauce');
      assertItem(result, { name: 'Pasta Sauce', quantity: 1, unit: 'jar' });
    });
  });

  // ── Confidence Score Verification ───────────────────────────────────────

  describe('Confidence scores', () => {
    it('x-pattern items have confidence 0.9', () => {
      const result = parseVoiceText('milk x2');
      expect(result.confidence).toBe(0.9);
    });

    it('"N unit of name" patterns have confidence 0.9', () => {
      const result = parseVoiceText('2 kg of rice');
      expect(result.confidence).toBe(0.9);
    });

    it('word quantity patterns have confidence 0.8+', () => {
      const result = parseVoiceText('a dozen eggs');
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('fallback bare name has confidence 0.5', () => {
      const result = parseVoiceText('bananas');
      expect(result.confidence).toBe(0.5);
    });

    it('empty string has confidence 0', () => {
      const result = parseVoiceText('');
      expect(result.confidence).toBe(0);
    });
  });

  // ── Title Case Verification ─────────────────────────────────────────────

  describe('Title case output', () => {
    it('converts lowercase input to title case', () => {
      const result = parseVoiceText('organic valley 2% milk');
      expect(result.name).toBe('Organic Valley 2% Milk');
    });

    it('preserves uppercase words appropriately', () => {
      const result = parseVoiceText('coca cola zero');
      expect(result.name).toBe('Coca Cola Zero');
    });
  });
});

// ─── IFTTT Webhook Tests ─────────────────────────────────────────────────────
// Tests for the IFTTT bridge (signRequest, verifySignature, buildWebhookUrl)
// These are pure functions that don't need external dependencies.

const TEST_SECRET = 'test-secret-key-12345';
const TEST_PAYLOAD = { itemName: 'Milk', quantity: 2, unit: 'each' };
const TEST_SECRET_2 = 'different-secret-67890';
const TEST_ITEM: ParsedItem = { name: 'Milk', quantity: 2, unit: 'each', confidence: 0.9 };
const TEST_ITEM_2: ParsedItem = { name: 'Chicken Breast & Rice', quantity: 1, unit: 'lb', confidence: 0.9 };

describe('IFTTT Webhook Bridge', () => {
  describe('signRequest', () => {
    it('should produce a hex signature for a simple payload', async () => {
      const sig = await signRequest(TEST_PAYLOAD, TEST_SECRET);
      expect(sig).toBeTruthy();
      expect(typeof sig).toBe('string');
      // HMAC-SHA256 produces 64 hex chars
      expect(sig.length).toBe(64);
    });

    it('should produce different signatures for different secrets', async () => {
      const [sig1, sig2] = await Promise.all([
        signRequest(TEST_PAYLOAD, TEST_SECRET),
        signRequest(TEST_PAYLOAD, TEST_SECRET_2),
      ]);
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different payloads', async () => {
      const [sig1, sig2] = await Promise.all([
        signRequest(TEST_PAYLOAD, TEST_SECRET),
        signRequest({ ...TEST_PAYLOAD, quantity: 3 }, TEST_SECRET),
      ]);
      expect(sig1).not.toBe(sig2);
    });

    it('should handle empty payload', async () => {
      const sig = await signRequest({}, TEST_SECRET);
      expect(sig).toBeTruthy();
      expect(sig.length).toBe(64);
    });
  });

  describe('verifySignature', () => {
    it('should verify a valid signature', async () => {
      const sig = await signRequest(TEST_PAYLOAD, TEST_SECRET);
      expect(await verifySignature(TEST_PAYLOAD, sig, TEST_SECRET)).toBe(true);
    });

    it('should reject a tampered signature', async () => {
      const sig = await signRequest(TEST_PAYLOAD, TEST_SECRET);
      const tamperedSig = sig.slice(0, 60) + 'abcdef';
      expect(await verifySignature(TEST_PAYLOAD, tamperedSig, TEST_SECRET)).toBe(false);
    });

    it('should reject a signature from a different secret', async () => {
      const sig = await signRequest(TEST_PAYLOAD, TEST_SECRET);
      expect(await verifySignature(TEST_PAYLOAD, sig, TEST_SECRET_2)).toBe(false);
    });

    it('should reject an empty signature', async () => {
      expect(await verifySignature(TEST_PAYLOAD, '', TEST_SECRET)).toBe(false);
    });

    it('should reject a null/undefined signature', async () => {
      expect(await verifySignature(TEST_PAYLOAD, null as any, TEST_SECRET)).toBe(false);
      expect(await verifySignature(TEST_PAYLOAD, undefined as any, TEST_SECRET)).toBe(false);
    });
  });

  describe('buildWebhookUrl', () => {
    it('should build a URL with signed payload', async () => {
      const baseUrl = 'https://relay.example.com';
      const url = await buildWebhookUrl(baseUrl, TEST_ITEM);
      expect(url).toContain(baseUrl);
      expect(url).toContain('api/webhook/ifttt');
      expect(url).toContain('name=Milk');
      expect(url).toContain('quantity=2');
      expect(url).toContain('timestamp=');
      expect(url).toContain('sig=');
      // Signature should be 64 hex chars
      const sigMatch = url.match(/sig=([a-f0-9]{64})/);
      expect(sigMatch).not.toBeNull();
    });

    it('should encode special characters in item names', async () => {
      const baseUrl = 'https://relay.example.com';
      const url = await buildWebhookUrl(baseUrl, TEST_ITEM_2);
      expect(url).toContain('Chicken+Breast+%26+Rice');
    });
  });
});