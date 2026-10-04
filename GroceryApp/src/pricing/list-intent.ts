/**
 * List intent — what a grocery line actually asks for.
 *
 * Derived only from fields the list already syncs (name, quantity, unit,
 * notes, isChecked), so no schema change is needed and every device derives
 * the same intent. The same vocabulary parses offers (offer-evidence.ts), so
 * a list line and an offer are matched with one set of rules.
 *
 *  - Variant words (GREEN, whole, lactose-free, JAMAICAN, …) are hard
 *    requirements. A word in ALL CAPS is also treated as a requirement.
 *  - "sale only" / "only if on sale" → sale-only rule.
 *  - "no subs" forbids substitutes; "subs ok" allows them. Default: not allowed.
 *  - "store hint: Costco" / "@Costco" is context, never a mandatory stop.
 *  - Anything else in notes ("for kids") stays a note — no allergy, brand or
 *    medical rule is invented from it.
 *  - Quantity: an empty unit means the amount is a planning assumption
 *    (shown as such); 0 means "not buying"; a non-number means unknown.
 */

import type { Quantity } from './units';

/** Variant vocabulary. Values in the same exclusive group contradict each other. */
interface VariantDef {
  attr: string;
  group: string;
  exclusive: boolean;
  aliases: RegExp;
}

const VARIANTS: VariantDef[] = [
  { attr: 'green', group: 'colour', exclusive: true, aliases: /\bgreen\b/i },
  { attr: 'red', group: 'colour', exclusive: true, aliases: /\bred\b/i },
  { attr: 'black', group: 'colour', exclusive: true, aliases: /\bblack\b/i },
  { attr: 'yellow', group: 'colour', exclusive: true, aliases: /\byellow\b/i },
  { attr: 'purple', group: 'colour', exclusive: true, aliases: /\bpurple\b/i },
  { attr: 'whole', group: 'milkfat', exclusive: true, aliases: /\b(whole|homo|homogeni[sz]ed)\b|3\.25\s?%/i },
  { attr: '2%', group: 'milkfat', exclusive: true, aliases: /(^|\s)2\s?%/ },
  { attr: '1%', group: 'milkfat', exclusive: true, aliases: /(^|\s)1\s?%/ },
  { attr: 'skim', group: 'milkfat', exclusive: true, aliases: /\b(skim|fat[- ]free|0\s?%)/i },
  { attr: 'lactose-free', group: 'lactose', exclusive: false, aliases: /\blactose[- ]?free\b|\blactofree\b/i },
  { attr: 'salted', group: 'salt', exclusive: true, aliases: /\bsalted\b/i },
  { attr: 'unsalted', group: 'salt', exclusive: true, aliases: /\bunsalted\b/i },
  { attr: 'organic', group: 'organic', exclusive: false, aliases: /\borganic\b/i },
  { attr: 'seedless', group: 'seedless', exclusive: false, aliases: /\bseedless\b/i },
  { attr: 'gluten-free', group: 'gluten', exclusive: false, aliases: /\bgluten[- ]?free\b/i },
  { attr: 'jamaican', group: 'style:jamaican', exclusive: false, aliases: /\bjamaican\b/i },
];

const VARIANT_BY_ATTR = new Map(VARIANTS.map((v) => [v.attr, v]));

/** Group of a known variant attribute (e.g. 'red' → 'colour'). */
export function variantGroup(attr: string): string | undefined {
  return VARIANT_BY_ATTR.get(attr)?.group;
}

export interface Requirement {
  attr: string;
  group: string;
  exclusive: boolean;
}

const SALE_ONLY_RE = /\b(sale[- ]only|only\s+(if|when)\s+on\s+sale|on\s+sale\s+only|if\s+on\s+sale)\b/i;
const NO_SUBS_RE = /\bno\s+sub(s|stitutes?|stitutions?)?\b/i;
const SUBS_OK_RE = /\b(subs?|substitutes?|substitutions?)\s+(ok|okay|fine|allowed)\b|\bany\s+brand\b/i;
const STORE_HINT_RE = /(?:store\s*hint|from)\s*:\s*([^;·\n]+)|@([A-Za-z0-9&' -]+?)(?=$|[;·,\n])/i;

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'for', 'some', 'fresh', 'pack', 'pk', 'bag', 'box', 'x',
  // measurement words — quantities are parsed separately
  'g', 'kg', 'lb', 'lbs', 'oz', 'ml', 'l', 'ea', 'pc', 'pcs', 'ct',
]);
const ALL_CAPS_RE = /^[A-Z][A-Z'-]{2,}$/;

/** Variant attributes evidenced by free text (an offer name or a list line). */
export function parseVariantAttributes(text: string): string[] {
  const found: string[] = [];
  for (const v of VARIANTS) {
    if (v.aliases.test(text) && !found.includes(v.attr)) found.push(v.attr);
  }
  return found;
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && /(ches|shes|oes|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Base product words with variant, emphasis and quantity tokens removed:
 * "GREEN grapes" → "grape", "whole lactose-free milk" → "milk".
 */
export function productKey(text: string): string {
  let t = text.replace(SALE_ONLY_RE, ' ');
  for (const v of VARIANTS) t = t.replace(new RegExp(v.aliases.source, 'gi'), ' ');
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w) && !/^\d/.test(w))
    .map(singular)
    .join(' ')
    .trim();
}

/** Does the offer's product name plausibly name the same product as the line? */
export function productMatches(lineKey: string, offerName: string): boolean {
  if (!lineKey) return true;
  const offerWords = new Set(productKey(offerName).split(' '));
  return lineKey.split(' ').every((w) => offerWords.has(w));
}

export type QuantitySource = 'explicit' | 'assumed' | 'unknown' | 'zero';

export interface BasketLine {
  itemId: string;
  /** The line exactly as written. */
  rawText: string;
  /** Name with intent phrases (e.g. "sale only") removed. */
  displayName: string;
  /** Notes with recognised intent phrases removed; may be empty. */
  notes: string;
  checked: boolean;
  quantity: Quantity | null;
  quantitySource: QuantitySource;
  requirements: Requirement[];
  saleOnly: boolean;
  allowSubstitution: boolean;
  storeHint?: string;
  productKey: string;
}

export interface LineSource {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  notes?: string;
  isChecked?: boolean;
}

function requirementsFrom(name: string): Requirement[] {
  const reqs: Requirement[] = [];
  for (const attr of parseVariantAttributes(name)) {
    const v = VARIANT_BY_ATTR.get(attr)!;
    reqs.push({ attr, group: v.group, exclusive: v.exclusive });
  }
  // ALL-CAPS emphasis on a word the vocabulary doesn't know is still a
  // requirement the offer must evidence (it is never contradicted, only
  // unconfirmed).
  for (const word of name.split(/\s+/)) {
    const bare = word.replace(/[^A-Za-z'-]/g, '');
    if (!ALL_CAPS_RE.test(bare)) continue;
    const attr = bare.toLowerCase();
    if (reqs.some((r) => r.attr === attr) || parseVariantAttributes(bare).length > 0) continue;
    reqs.push({ attr, group: `emphasis:${attr}`, exclusive: false });
  }
  return reqs;
}

/** Collapse the separators left behind after removing intent phrases. */
function tidy(text: string): string {
  return text
    .replace(/\s*([;·,])(\s*[;·,])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s;·,-]+|[\s;·,-]+$/g, '');
}

/** Derive the planning intent of one list line. */
export function deriveBasketLine(item: LineSource): BasketLine {
  const name = item.name ?? '';
  const notes = item.notes ?? '';
  const both = `${name}\n${notes}`;

  const saleOnly = SALE_ONLY_RE.test(both);
  const allowSubstitution = !NO_SUBS_RE.test(both) && SUBS_OK_RE.test(both);
  const hintMatch = notes.match(STORE_HINT_RE);
  const storeHint = hintMatch ? (hintMatch[1] ?? hintMatch[2] ?? '').trim() || undefined : undefined;

  const cleanNotes = tidy(
    notes
      .replace(SALE_ONLY_RE, '')
      .replace(NO_SUBS_RE, '')
      .replace(SUBS_OK_RE, '')
      .replace(STORE_HINT_RE, ''),
  );
  const displayName = tidy(name.replace(SALE_ONLY_RE, '').replace(/\(\s*\)/g, ''));

  let quantity: Quantity | null;
  let quantitySource: QuantitySource;
  const q = item.quantity;
  if (typeof q !== 'number' || !Number.isFinite(q) || q < 0) {
    quantity = null;
    quantitySource = 'unknown';
  } else if (q === 0) {
    quantity = { amount: 0, unit: item.unit || 'ea' };
    quantitySource = 'zero';
  } else if (!item.unit || !item.unit.trim()) {
    quantity = { amount: q, unit: 'ea' };
    quantitySource = 'assumed';
  } else {
    quantity = { amount: q, unit: item.unit.trim() };
    quantitySource = 'explicit';
  }

  return {
    itemId: item.id,
    rawText: name,
    displayName: displayName || name,
    notes: cleanNotes,
    checked: item.isChecked === true,
    quantity,
    quantitySource,
    requirements: requirementsFrom(displayName),
    saleOnly,
    allowSubstitution,
    storeHint,
    productKey: productKey(displayName),
  };
}

/** Human label for a requirement, matching how the list wrote it. */
export function requirementLabel(r: Requirement): string {
  return r.attr.toUpperCase();
}
