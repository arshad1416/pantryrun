/**
 * Lightweight regex-based NLP parser for voice grocery text.
 *
 * Handles natural language patterns like:
 *   "2% milk x2"           → {name:"2% Milk", quantity:2, unit:""}
 *   "half a kilo of chicken breast" → {name:"Chicken Breast", quantity:0.5, unit:"kg"}
 *   "a dozen eggs"         → {name:"Eggs", quantity:12, unit:"each"}
 *   "half a dozen eggs"    → {name:"Eggs", quantity:6, unit:"each"}
 *   "bananas"              → {name:"Bananas", quantity:1, unit:""}
 *   "1kg of rice"          → {name:"Rice", quantity:1, unit:"kg"}
 *   "2 litres of milk"     → {name:"Milk", quantity:2, unit:"L"}
 *   "one and a half litres of milk" → {name:"Milk", quantity:1.5, unit:"L"}
 *   "a gallon of milk"     → {name:"Milk", quantity:3.785, unit:"L"}
 *   "add 2 milk"           → {name:"Milk", quantity:2, unit:""}
 *   "a couple of avocados" → {name:"Avocados", quantity:2, unit:""}
 *   "2 x 355 ml coke"      → {name:"Coke", quantity:710, unit:"ml"}
 *   "put eggs on the list" → {name:"Eggs", quantity:1, unit:""}
 *   "organic valley 2% milk x2 please" → {name:"Organic Valley 2% Milk", quantity:2, unit:""}
 *
 * unit "" means packages of whatever size the store sells (see
 * pricing/quantity.ts); "each" only when a count was spoken ("a dozen").
 *
 * Exports a single function: `parseVoiceText(text: string): ParsedItem`
 */

import type { ParsedItem } from './types';

// ─── Unit Aliases ─────────────────────────────────────────────────────────────

interface UnitAlias {
  unit: string;
  multiplier?: number;
}

const UNIT_ALIASES: Record<string, UnitAlias> = {
  // Volume
  litre: { unit: 'L' },
  litres: { unit: 'L' },
  liter: { unit: 'L' },
  liters: { unit: 'L' },
  l: { unit: 'L' },
  ml: { unit: 'ml' },
  millilitre: { unit: 'ml' },
  millilitres: { unit: 'ml' },
  milliliter: { unit: 'ml' },
  milliliters: { unit: 'ml' },
  gallon: { unit: 'L', multiplier: 3.785 },
  gallons: { unit: 'L', multiplier: 3.785 },
  quart: { unit: 'L', multiplier: 0.946 },
  quarts: { unit: 'L', multiplier: 0.946 },

  // Mass / Weight
  kilo: { unit: 'kg' },
  kilos: { unit: 'kg' },
  kilogram: { unit: 'kg' },
  kilograms: { unit: 'kg' },
  kg: { unit: 'kg' },
  gram: { unit: 'g' },
  grams: { unit: 'g' },
  g: { unit: 'g' },
  pound: { unit: 'lb' },
  pounds: { unit: 'lb' },
  lb: { unit: 'lb' },
  lbs: { unit: 'lb' },
  ounce: { unit: 'oz' },
  ounces: { unit: 'oz' },
  oz: { unit: 'oz' },

  // Count-based
  dozen: { unit: 'each', multiplier: 12 },
  dozens: { unit: 'each', multiplier: 12 },
  pack: { unit: 'pack' },
  packs: { unit: 'pack' },
  bag: { unit: 'bag' },
  bags: { unit: 'bag' },
  bottle: { unit: 'bottle' },
  bottles: { unit: 'bottle' },
  can: { unit: 'can' },
  cans: { unit: 'can' },
  jar: { unit: 'jar' },
  jars: { unit: 'jar' },
  box: { unit: 'box' },
  boxes: { unit: 'box' },
  bunch: { unit: 'bunch' },
  bunches: { unit: 'bunch' },
  piece: { unit: 'pcs' },
  pieces: { unit: 'pcs' },
  pcs: { unit: 'pcs' },
  each: { unit: 'each' },
  loaf: { unit: 'loaf' },
  loaves: { unit: 'loaf' },
  head: { unit: 'head' },
  heads: { unit: 'head' },
  clove: { unit: 'clove' },
  cloves: { unit: 'clove' },
};

// ─── Word Quantities ──────────────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

/** "twenty four", "twenty-four" → 24 */
const TENS = new Set(['twenty', 'thirty', 'forty', 'fifty']);

// ─── Filler Words ─────────────────────────────────────────────────────────────

/**
 * Politeness and command words dropped from the START or END of a phrase —
 * never from the middle, where they belong to the product ("a can of soup",
 * "mac and cheese", "lord of the rings cereal").
 */
const FILLER_WORDS = new Set([
  'add',
  'put',
  'please',
  'pls',
  'thanks',
  'thank',
  'need',
  'want',
  'get',
  'buy',
  'have',
  'some',
  'the',
  'and',
  'i',
  'me',
  'my',
  'we',
  'us',
  'can',
  'could',
  'would',
  'should',
  'like',
]);

// ─── Multi-word Filler Prefixes ──────────────────────────────────────────────

const MULTI_WORD_FILLER_PREFIXES = [
  'i would like to get',
  'i need to get',
  'can i get',
  'can i have',
  'could i get',
  'i would like',
  'i need',
  'i want',
  'would like',
  'we need',
  'we want',
].sort((a, b) => b.length - a.length); // longest first

/** "… on the list", "… to my shopping list", "… onto our grocery list" */
const LIST_SUFFIX = /\s+(?:on|to|onto|in)\s+(?:the\s+|my\s+|our\s+)?(?:grocery\s+|shopping\s+)?list\s*$/i;
/** "… thank you" */
const THANK_YOU_SUFFIX = /\s+thank\s+you\s*$/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Title-case a string (first letter uppercase, rest lowercase).
 * Preserves hyphenated words by capitalizing each segment.
 * Preserves possessives (e.g., "Jerry's" → "Jerry'S").
 */
function titleCase(text: string): string {
  return text
    .split(' ')
    .map((word) => {
      if (word.length === 0) return word;
      // Keep words like "2%" or "1/2" as-is
      if (/^[\d%./]+$/.test(word)) return word;

      // Handle hyphenated words: "free-range" → "Free-Range"
      if (word.includes('-')) {
        return word
          .split('-')
          .map((part) => {
            if (part.length === 0) return part;
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
          })
          .join('-');
      }

      // Handle possessives: "jerry's" → "Jerry'S" but "jerrys" → "Jerrys"
      // For now, just capitalize first letter, keep rest
      // This is consistent with how titleCase works with apostrophes
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * Strip filler words from the beginning and end of a phrase.
 * Filters common voice command prefixes ("can I get", "add … to the list")
 * and politeness words, leaving the middle of the phrase alone.
 */
function stripFillers(text: string): string {
  let cleaned = text.toLowerCase().trim().replace(/\s+/g, ' ');

  // "put eggs on the list", "add milk to my shopping list"
  cleaned = cleaned.replace(THANK_YOU_SUFFIX, '').replace(LIST_SUFFIX, '');

  // Remove multi-word filler prefixes first (longest match wins)
  for (const filler of MULTI_WORD_FILLER_PREFIXES) {
    if (cleaned.startsWith(filler + ' ')) {
      cleaned = cleaned.slice(filler.length).trim();
      break;
    }
  }

  // Remove leading/trailing filler words
  const words = cleaned.split(' ').filter((w) => w.length > 0);
  let start = 0;
  let end = words.length;
  while (start < end && FILLER_WORDS.has(words[start])) start++;
  while (end > start && FILLER_WORDS.has(words[end - 1])) end--;

  return words.slice(start, end).join(' ').replace(LIST_SUFFIX, '').trim();
}

// ─── Main Parser ──────────────────────────────────────────────────────────────

/**
 * Parse a voice text string into a structured ParsedItem.
 *
 * Handles patterns:
 *   - "xN" suffix for quantity (e.g. "milk x2")
 *   - a leading quantity, as digits ("2 milk", "1.5 kg", "2x milk") or words
 *     ("two", "twenty four", "a couple of", "one and a half", "half a")
 *   - an optional unit after it ("2 litres", "a bag", "a dozen", "a gallon"),
 *     then an optional "of" ("1kg of rice", "half a dozen eggs")
 *   - multipacks: "2 x 355 ml coke" → 710 ml of Coke
 *   - list commands: "put eggs on the list", "add milk to my list"
 *   - Bare item names (fallback: qty=1, no unit)
 *
 * With no unit spoken the unit is '' — "N packages of whatever size the
 * store sells" (pricing/quantity.ts) — not "each", which would claim a
 * count and rule out every packaged product ("milk" is not 1 each).
 *
 * @param text - Raw voice transcription text
 * @returns ParsedItem with name, quantity, unit, and confidence score
 */
export function parseVoiceText(text: string): ParsedItem {
  // Normalize whitespace
  const raw = text.trim();

  if (!raw) {
    return { name: '', quantity: 1, unit: PACKAGE_UNIT, confidence: 0 };
  }

  // Step 1: Strip filler words
  const cleaned = stripFillers(raw);

  // If stripping left nothing, use original raw
  const working = cleaned || raw;

  // Step 2: Attempt multi-pattern parsing
  return tryParse(working);
}

/** No unit spoken: a number of packages (pricing/quantity.ts PACKAGE_WORDS). */
const PACKAGE_UNIT = '';

interface LeadingQuantity {
  quantity: number;
  rest: string;
  /** spoken as a word ("two", "a", "half") rather than digits */
  word: boolean;
  /** an article alone ("a banana") — not really a quantity */
  article: boolean;
}

const NUMBER_RE = /^(\d+\/\d+|\d+(?:\.\d+)?)/;

function parseNumber(token: string): number {
  if (token.includes('/')) {
    const [n, d] = token.split('/').map(Number);
    return d > 0 ? n / d : NaN;
  }
  return parseFloat(token);
}

/** A unit word (from UNIT_ALIASES) at the start of `text`. */
function readUnit(text: string): { alias: UnitAlias; rest: string } | null {
  const m = text.match(/^([a-z]+)\b\.?\s*(.*)$/i);
  if (!m) return null;
  const alias = UNIT_ALIASES[m[1].toLowerCase()];
  return alias ? { alias, rest: m[2] } : null;
}

/** "and a half" / "and one half" after a whole number */
function readAndAHalf(text: string): { half: number; rest: string } {
  const m = text.match(/^and\s+(?:a|one)\s+half\b\s*(.*)$/i);
  return m ? { half: 0.5, rest: m[1] } : { half: 0, rest: text };
}

function readLeadingQuantity(text: string): LeadingQuantity | null {
  // Digits: "2 milk", "1.5 kg", "1/2 lb", "500g" (glued only to a unit word)
  const num = text.match(NUMBER_RE);
  if (num) {
    const after = text.slice(num[0].length);
    if (after !== '' && !/^(?:\s|x\s)/i.test(after) && !readUnit(after)) return null; // "2%", "7up"
    const { half, rest } = readAndAHalf(after.trim());
    const quantity = parseNumber(num[0]) + half;
    return Number.isFinite(quantity) && quantity > 0 ? { quantity, rest, word: false, article: false } : null;
  }

  // "a couple of eggs", "a pair of …"
  const couple = text.match(/^(?:a\s+)?(?:couple|pair)(?:\s+of)?\s+(.+)$/i);
  if (couple) return { quantity: 2, rest: couple[1], word: true, article: false };

  // "half a kilo", "a half litre", "half dozen"
  const half = text.match(/^(?:a\s+)?half\s+(?!and\b|&)(?:(?:a|an)\s+)?(.+)$/i);
  if (half) return { quantity: 0.5, rest: half[1], word: true, article: false };

  // "two", "twenty four", "twenty-four", "one and a half"
  const words = text.match(/^([a-z]+)(?:[\s-]+([a-z]+))?\b\s*(.*)$/i);
  if (words) {
    const first = words[1].toLowerCase();
    if (first in NUMBER_WORDS) {
      let quantity = NUMBER_WORDS[first];
      let rest = `${words[2] ?? ''} ${words[3]}`.trim();
      const second = (words[2] ?? '').toLowerCase();
      if (TENS.has(first) && second in NUMBER_WORDS && NUMBER_WORDS[second] < 10) {
        quantity += NUMBER_WORDS[second];
        rest = words[3];
      }
      const halfAfter = readAndAHalf(rest);
      return { quantity: quantity + halfAfter.half, rest: halfAfter.rest, word: true, article: false };
    }
  }

  // "a banana", "an apple", "a dozen eggs", "a bag of apples"
  const article = text.match(/^an?\s+(.+)$/i);
  if (article) return { quantity: 1, rest: article[1], word: true, article: true };

  return null;
}

/** "x 355 ml coke" after the count of a multipack */
function readMultipack(count: number, text: string): ParsedItem | null {
  const m = text.match(/^x\s*(\d+(?:\.\d+)?)\s*([a-z]+)\b\.?\s+(?:of\s+)?(.+)$/i);
  if (!m) return null;
  const alias = UNIT_ALIASES[m[2].toLowerCase()];
  if (!alias || alias.multiplier != null) return null;
  const size = parseFloat(m[1]);
  if (!(size > 0)) return null;
  return {
    name: titleCase(m[3].trim()),
    quantity: +(count * size).toFixed(3),
    unit: alias.unit,
    confidence: 0.9,
    notes: `${count} × ${size} ${alias.unit}`,
  };
}

function tryParse(text: string): ParsedItem {
  // Pattern 1: "name xN" — suffix multiplier (e.g. "2% milk x2", "bananas x3")
  const xPattern = text.match(/^(.+?)\s+x(\d+(?:\.\d+)?)\s*$/i);
  if (xPattern) {
    const name = xPattern[1].trim();
    const quantity = parseFloat(xPattern[2]);
    if (name && quantity > 0) {
      return {
        name: titleCase(name),
        quantity,
        unit: PACKAGE_UNIT,
        confidence: 0.9,
      };
    }
  }

  // Pattern 2: leading quantity, optional unit, optional "of", then the name
  const lead = readLeadingQuantity(text);
  if (lead) {
    if (!lead.word) {
      const pack = readMultipack(lead.quantity, lead.rest);
      if (pack) return pack;
    }
    // "2x milk", "2 x milk"
    let rest = lead.word ? lead.rest : lead.rest.replace(/^x\s+/i, '');
    let quantity = lead.quantity;
    let unit = PACKAGE_UNIT;
    let confidence = 0.8;
    const unitWord = readUnit(rest);
    if (unitWord) {
      const afterUnit = unitWord.rest.match(/^of\s+(.+)$/i);
      const name = (afterUnit ? afterUnit[1] : unitWord.rest).trim();
      if (name) {
        quantity = unitWord.alias.multiplier != null ? +(quantity * unitWord.alias.multiplier).toFixed(3) : quantity;
        unit = unitWord.alias.unit;
        rest = name;
        confidence = lead.word ? 0.85 : afterUnit ? 0.9 : 0.85;
      }
    } else {
      rest = rest.replace(/^of\s+/i, '');
      if (lead.article) confidence = 0.6;
    }
    rest = rest.trim();
    if (rest) {
      return { name: titleCase(rest), quantity, unit, confidence };
    }
  }

  // Fallback: treat entire text as item name, qty=1, no unit (one package)
  return {
    name: titleCase(text),
    quantity: 1,
    unit: PACKAGE_UNIT,
    confidence: 0.5,
  };
}
