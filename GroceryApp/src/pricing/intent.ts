/**
 * Intent — what a list line actually asks for.
 *
 * Reads the item's own text (name + notes) into hard requirements a
 * matched product must satisfy. Nothing here rewrites saved data: the
 * person's "LF milk" stays "LF milk" on the list, and its intent is
 * derived each time it's compared.
 *
 *  - Canonical variants: "LF", "lactose free", "lactose-free" are one
 *    attribute; "3.25%", "homo", "whole" are one fat level; "mayonnaise"
 *    is "mayo"; retailer names for one product ("mini carrots") fold to
 *    one phrase. Product names go through the same canonicalization, so
 *    both sides compare like with like.
 *  - A trailing "for …" on the name ("garlic mayo for kids") says who it's
 *    for, not what to buy: it never becomes a product requirement.
 *  - Hard attributes (lactose-free, whole, green, Jamaican, garlic, …)
 *    are always retained, even when substitutes are allowed. One written
 *    anywhere in a note ("milk (lactose free)") is a requirement unless
 *    negated ("no garlic").
 *  - "sale only" notes make the item a hold until a qualifying sale exists.
 *  - "any brand" / "subs ok" notes allow substitutes: only the head noun
 *    and hard attributes must then match. "no subs" (the default) keeps
 *    every word of the name.
 *
 * Pure functions only.
 */

// ─── Tokens ─────────────────────────────────────────────────────────────────

/** Words that add no matching value in grocery context */
export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'without', 'fresh', 'frozen', 'organic', 'natural', 'premium',
  'value', 'selected', 'choice', 'best', 'plus', 'all', 'each', 'per',
  'pack', 'bag', 'box', 'bottle', 'can', 'jar', 'tub', 'tray', 'bunch',
  'kg', 'g', 'ml', 'l', 'oz', 'lb', 'litre', 'liter', 'gram', 'grams',
  'piece', 'pieces', 'count', 'size', 'large', 'medium', 'small',
  'grade', 'type', 'style', 'brand', 'save', 'caisse', 'chaque',
]);

/**
 * Phrase → canonical token, applied before punctuation is stripped (so
 * "3.25%" and "lactose-free" survive). Order matters: longer phrases first.
 */
const CANONICAL_PHRASES: [RegExp, string][] = [
  [/\blacto(?:se)?[\s-]*free\b/g, ' lactosefree '],
  [/\blf\b/g, ' lactosefree '],
  [/\bgluten[\s-]*free\b/g, ' glutenfree '],
  [/\b3\.25\s*%|\b3\.25\s*(?:mf|m\.f\.)|\bhomo(?:genized|genised)?\b/g, ' whole '],
  [/(?:^|\s)2\s*%/g, ' twopercent '],
  [/(?:^|\s)1\s*%/g, ' onepercent '],
  [/(?:^|\s)0\s*%|\bskim(?:med)?\b|\bfat[\s-]*free\b/g, ' skim '],
  [/\bmayonnaise\b/g, ' mayo '],
  // Same product, different retailer names. Whole phrases only: "mini"
  // alone is too generic ("mini pretzels") to be a synonym.
  [/\b(?:mini|baby)[\s-]+carrots?\b/g, ' baby carrots '],
];

/**
 * Attributes that distinguish variants of the same product. When a name
 * or note carries one, a product without it is a different product.
 */
export const HARD_ATTRIBUTES = new Set([
  'lactosefree', 'glutenfree', 'whole', 'twopercent', 'onepercent', 'skim',
  'green', 'red', 'black', 'seedless', 'jamaican', 'garlic', 'spicy', 'mild',
  'unsalted', 'salted', 'decaf', 'diet', 'vegan', 'halal', 'kosher',
]);

/** Crude plural folding so "grapes" ≡ "grape" and "patties" ≡ "patty". */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 4 && token.endsWith('oes')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Lowercase and replace variant phrases with their canonical token. */
export function canonicalize(text: string): string {
  let out = ` ${text.toLowerCase()} `;
  for (const [re, token] of CANONICAL_PHRASES) out = out.replace(re, token);
  return out;
}

/**
 * Meaningful, stemmed, canonical tokens of a product name. Hyphens split
 * ("garlic-mayo"), variant phrases fold ("LF" → lactosefree).
 */
export function extractKeywords(name: string): string[] {
  if (!name || typeof name !== 'string') return [];
  return canonicalize(name)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
    .map(stem);
}

/**
 * Score how well query tokens match product tokens (0..1). Whole tokens
 * only — "milk" must not match "buttermilk". Multi-word queries need at
 * least two hits so "green grapes" does not match "red grapes".
 */
export function matchScore(queryTokens: string[], productTokens: string[]): number {
  if (queryTokens.length === 0 || productTokens.length === 0) return 0;
  const product = new Set(productTokens);
  const hits = queryTokens.filter((t) => product.has(t)).length;
  if (hits < 2 && queryTokens.length > 1) return 0;
  return hits / queryTokens.length;
}

// ─── Intent ─────────────────────────────────────────────────────────────────

export type SubstitutionPolicy = 'exact' | 'substitutes_ok';

export interface ItemIntent {
  /** Tokens a matched product name must all contain. */
  requiredTokens: string[];
  /** Hard attributes among them — retained under any substitution policy. */
  hardAttributes: string[];
  /** Tokens only a note demanded — unverifiable without a matched product name. */
  noteTokens: string[];
  saleOnly: boolean;
  substitution: SubstitutionPolicy;
}

const SALE_ONLY_RE = /\b(sale only|only (if )?on sale|on sale only|if on sale|when on sale)\b/i;
const SUBS_OK_RE = /\b(any brand|subs? ok|substitutes? (are )?ok|substitution ok|or similar|any kind)\b/i;
const NO_SUBS_RE = /\b(no subs?|no substitut\w*|exact(ly)?( brand)?)\b/i;
const NOTE_REQUIREMENT_RES = [
  /\bmust be ([a-z0-9 .%-]+)/i,
  /\bonly ([a-z0-9 .%-]+)/i,
  /\b([a-z0-9.%-]+) only\b/i,
];

/** "… for kids" / "… for the party": who it's for, never a product word. */
const PURPOSE_RE = /\s+for\s+.+$/i;

/** Words in a note's requirement phrase that are policy, not product. */
const POLICY_WORDS = new Set(['sale', 'brand', 'any', 'sub', 'ok', 'exact', 'exactly']);

/**
 * Read the shopping rules a person wrote on an item. Grammar is deliberately
 * small: the item name's own words, "sale only" phrases, substitution
 * phrases, and "must be X" / "only X" / "X only" in notes.
 */
export function parseItemIntent(item: { name: string; notes?: string }): ItemIntent {
  const nameTokens = extractKeywords(item.name.replace(PURPOSE_RE, ''));
  const notes = item.notes ?? '';
  const saleOnly = SALE_ONLY_RE.test(notes);
  const substitution: SubstitutionPolicy =
    SUBS_OK_RE.test(notes) && !NO_SUBS_RE.test(notes) ? 'substitutes_ok' : 'exact';

  const noteTokens: string[] = [];
  const withoutPolicy = notes.replace(SALE_ONLY_RE, ' ').replace(SUBS_OK_RE, ' ').replace(NO_SUBS_RE, ' ');
  for (const re of NOTE_REQUIREMENT_RES) {
    const m = withoutPolicy.match(re);
    if (m?.[1]) {
      for (const t of extractKeywords(m[1])) {
        if (!POLICY_WORDS.has(t) && !nameTokens.includes(t) && !noteTokens.includes(t)) {
          noteTokens.push(t);
        }
      }
    }
  }
  // A hard attribute written anywhere in a note ("(lactose free)", "green
  // ones") is a requirement too — unless negated ("no garlic", "not spicy").
  const unnegated = withoutPolicy.replace(/\b(?:no|not|non|without)[\s-]+[a-z0-9.%-]+(?:[\s-]+free)?/gi, ' ');
  for (const t of extractKeywords(unnegated)) {
    if (HARD_ATTRIBUTES.has(t) && !nameTokens.includes(t) && !noteTokens.includes(t)) noteTokens.push(t);
  }

  const all = [...nameTokens, ...noteTokens];
  const hardAttributes = all.filter((t) => HARD_ATTRIBUTES.has(t));

  let requiredTokens = all;
  if (substitution === 'substitutes_ok') {
    // Keep the head noun (last non-attribute word of the name) and every
    // hard attribute; brand and descriptive words may differ.
    const head = [...nameTokens].reverse().find((t) => !HARD_ATTRIBUTES.has(t));
    requiredTokens = [...new Set([...(head ? [head] : []), ...hardAttributes])];
  }

  return { requiredTokens, hardAttributes, noteTokens, saleOnly, substitution };
}

export type VariantCheck = 'match' | 'mismatch' | 'unverified';

/**
 * Does a product satisfy the intent? A price looked up by the item's own
 * name (no `matchedName`) implies the name's words, but a note's extra
 * requirement can't be verified without a product name.
 */
export function checkVariant(intent: ItemIntent, matchedName: string | undefined): VariantCheck {
  if (matchedName === undefined) {
    return intent.noteTokens.length > 0 && intent.requiredTokens.some((t) => intent.noteTokens.includes(t))
      ? 'unverified'
      : 'match';
  }
  const product = new Set(extractKeywords(matchedName));
  return intent.requiredTokens.every((t) => product.has(t)) ? 'match' : 'mismatch';
}
