/**
 * Checklist import — parse a pasted checklist into a reviewable preview.
 *
 * Accepts what people actually paste: Google Keep "copy" output
 * (☐ / ☑ lines), Markdown task lists ([ ] / [x]), bullets, or plain lines.
 * Nothing is applied until the person reviews the preview; this module
 * is pure and never touches the list.
 *
 *  - Headings ("Costco:", "A1 Cash & Carry", a title line) are context,
 *    never products. A heading's name is kept on the items under it as a
 *    "Section: …" note so the context survives the import.
 *  - Each item keeps its source line, checked state, explicit quantity
 *    and unit, and attached notes ("(3.25% only)", "— sale only",
 *    indented lines). A missing quantity becomes 1 and is labelled as an
 *    editable assumption; an invalid one excludes the line until fixed.
 *  - Ambiguous lines (a marker-less line inside a checklist that isn't a
 *    known store or "Title:") are flagged; the default is to treat them as
 *    headings, and the person can import them as items instead.
 *  - Duplicates — within the paste, or already on the list (a repeated
 *    paste) — default to "skip"; the person can add them anyway. Nothing
 *    is ever merged or summed, and lines whose variants conflict
 *    ("milk" vs "milk, lactose-free only") are flagged and kept apart.
 */

import { HARD_ATTRIBUTES, parseItemIntent } from '../pricing/intent';
import { quantityStatus } from '../pricing/quantity';
import { inferCategory } from '../utils/category';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ImportIssue =
  | 'quantity_assumed'
  | 'quantity_invalid'
  | 'empty_name'
  | 'ambiguous_heading'
  | 'duplicate_in_paste'
  | 'already_on_list'
  | 'variant_conflict';

export interface ParsedLine {
  /** 1-based line number in the pasted text */
  lineNo: number;
  /** The line exactly as pasted */
  source: string;
  kind: 'heading' | 'item';
  /** Heading text (headings) or the heading this item sits under (items) */
  section?: string;
  name: string;
  /** null only when the pasted value was invalid */
  quantity: number | null;
  unit: string;
  checked: boolean;
  /** Attached notes, as written */
  notes: string[];
  issues: ImportIssue[];
  /** For duplicates: the line number (or 'list') it duplicates */
  duplicateOf?: number | 'list';
}

export interface ExistingItem {
  name: string;
  notes?: string;
  isDeleted?: boolean;
}

/** The person's choices in the preview, keyed by line number. */
export interface ImportDecisions {
  /** Lines excluded by the person */
  excluded: Set<number>;
  /** Duplicate lines the person chose to add anyway */
  addDuplicate: Set<number>;
  /** Ambiguous headings the person chose to import as items */
  headingAsItem: Set<number>;
}

export interface ImportedItem {
  name: string;
  quantity: number;
  unit: string;
  notes?: string;
  isChecked: boolean;
  category: string;
  /** Source line, for the result summary */
  lineNo: number;
}

// ─── Line grammar ───────────────────────────────────────────────────────────

const CHECKED_RE = /^\s*(?:[-*•]\s*)?(?:☑|☒|✅|✓|✔|\[[xX✓]\])\s*/;
const UNCHECKED_RE = /^\s*(?:[-*•]\s*)?(?:☐|□|⬜|\[\s?\])\s*/;
const BULLET_RE = /^\s*[-*•]\s+/;
const NOTE_PREFIX_RE = /^\s*(?:note|notes)\s*:\s*/i;

/** Store and section names recognised as headings without a trailing colon. */
const KNOWN_HEADINGS = [
  'costco', 'no frills', 'nofrills', 'fortinos', 'loblaws', 'metro', 'food basics',
  'freshco', 'walmart', 'superstore', 'real canadian superstore', 'sobeys', 'farm boy',
  't&t', 't & t', 'longos', "longo's", 'shoppers', 'dollarama', 'a1 cash & carry',
  'a1 cash and carry', 'a1 cash n carry', 'adonis', 'giant tiger', 'zehrs', 'valu-mart',
  'produce', 'dairy', 'meat', 'bakery', 'frozen', 'pantry', 'beverages', 'household',
];

function normalizeHeading(text: string): string {
  return text.toLowerCase().replace(/[:\s]+$/g, '').replace(/\s+/g, ' ').trim();
}

const UNIT_ALIASES: Record<string, string> = {
  l: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L', ml: 'mL',
  kg: 'kg', g: 'g', lb: 'lb', lbs: 'lb', oz: 'oz', dozen: 'dozen', doz: 'dozen',
  pc: 'pcs', pcs: 'pcs', ea: 'ea', bag: 'bag', bags: 'bag', box: 'box', boxes: 'box',
  pack: 'pack', packs: 'pack', pk: 'pack', bottle: 'bottle', bottles: 'bottle',
  can: 'can', cans: 'can', jar: 'jar', jars: 'jar', loaf: 'loaf', loaves: 'loaf',
  bunch: 'bunch', bunches: 'bunch', carton: 'carton', cartons: 'carton',
};
const UNIT_PATTERN = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).join('|');
const AMOUNT_RE = new RegExp(`(?:^|\\s)(-?\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b\\.?`, 'i');
const LEADING_COUNT_RE = /^(-?\d+(?:[.,]\d+)?)\s*(?:[x×]\s*|\s+)(?=\S)/i;
const TRAILING_COUNT_RE = /\s[x×]\s*(-?\d+(?:[.,]\d+)?)\s*$/i;

function toNumber(raw: string): number {
  return Number(raw.replace(',', '.'));
}

interface ItemText {
  name: string;
  quantity: number | null;
  unit: string;
  notes: string[];
  quantityAssumed: boolean;
}

/** Split one item's text into name, quantity, unit and attached notes. */
export function parseItemText(text: string): ItemText {
  const notes: string[] = [];
  let rest = text.trim();

  // Parenthetical notes: "LF milk 3L (3.25% only)"
  rest = rest.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    if (inner.trim()) notes.push(inner.trim());
    return ' ';
  });
  // Trailing dash note: "ketchup - sale only", "Cascade pods — sale only"
  const dash = rest.match(/^(.*?\S)\s+[-—–]\s+(.+)$/);
  if (dash) {
    rest = dash[1];
    notes.push(dash[2].trim());
  }

  let quantity: number | null = null;
  let unit = '';
  const amount = rest.match(AMOUNT_RE);
  if (amount) {
    quantity = toNumber(amount[1]);
    unit = UNIT_ALIASES[amount[2].toLowerCase()] ?? amount[2];
    rest = rest.replace(amount[0], ' ');
  } else {
    const lead = rest.match(LEADING_COUNT_RE);
    const trail = rest.match(TRAILING_COUNT_RE);
    if (lead) {
      quantity = toNumber(lead[1]);
      rest = rest.slice(lead[0].length);
    } else if (trail) {
      quantity = toNumber(trail[1]);
      rest = rest.slice(0, rest.length - trail[0].length);
    }
  }

  const name = rest.replace(/\s+/g, ' ').replace(/^[\s,;:]+|[\s,;:.]+$/g, '');
  if (quantity === null) return { name, quantity: 1, unit, notes, quantityAssumed: true };
  return {
    name,
    quantity: quantityStatus(quantity) === 'invalid' ? null : quantity,
    unit,
    notes,
    quantityAssumed: false,
  };
}

// ─── Parse ──────────────────────────────────────────────────────────────────

/** Identity used for duplicate detection: canonical required tokens (name + note rules). */
export function itemKey(name: string, notes?: string): string {
  return [...parseItemIntent({ name, notes }).requiredTokens].sort().join(' ');
}

/** Same product, different hard attributes ("milk" vs "lactose-free milk"). */
function baseKey(name: string, notes?: string): string {
  return parseItemIntent({ name, notes }).requiredTokens.filter((t) => !HARD_ATTRIBUTES.has(t)).sort().join(' ');
}

/**
 * Parse pasted text into preview lines. `existing` is the current list,
 * so a repeated paste is recognised instead of doubling the list.
 */
export function parseChecklist(text: string, existing: ExistingItem[] = []): ParsedLine[] {
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  const hasMarkers = rawLines.some((l) => CHECKED_RE.test(l) || UNCHECKED_RE.test(l) || BULLET_RE.test(l));
  const out: ParsedLine[] = [];
  let section: string | undefined;
  let lastItem: ParsedLine | null = null;
  let sawContent = false;

  rawLines.forEach((source, idx) => {
    if (!source.trim()) return;
    const lineNo = idx + 1;
    const checkedMatch = source.match(CHECKED_RE);
    const uncheckedMatch = checkedMatch ? null : source.match(UNCHECKED_RE);
    const bulletMatch = checkedMatch || uncheckedMatch ? null : source.match(BULLET_RE);
    const marker = checkedMatch ?? uncheckedMatch ?? bulletMatch;

    if (!marker) {
      const trimmed = source.trim();
      const indented = /^\s{2,}|\t/.test(source);
      if (lastItem && (NOTE_PREFIX_RE.test(source) || indented)) {
        lastItem.notes.push(trimmed.replace(NOTE_PREFIX_RE, ''));
        return;
      }
      const isNamedHeading = trimmed.endsWith(':') || KNOWN_HEADINGS.includes(normalizeHeading(trimmed));
      if (isNamedHeading || hasMarkers) {
        const heading = trimmed.replace(/:\s*$/, '').trim();
        // A marker-less first line ("Groceries this week") is the list's
        // title: a heading, but not a section to stamp on every item.
        const isTitle = !isNamedHeading && !sawContent;
        const issues: ImportIssue[] = !isNamedHeading && !isTitle ? ['ambiguous_heading'] : [];
        out.push({
          lineNo, source, kind: 'heading', name: heading, ...(isTitle ? {} : { section: heading }),
          quantity: null, unit: '', checked: false, notes: [], issues,
        });
        section = isTitle ? undefined : heading;
        lastItem = null;
        sawContent = true;
        return;
      }
    }

    const body = marker ? source.slice(marker[0].length) : source;
    const parsed = parseItemText(body);
    const issues: ImportIssue[] = [];
    if (parsed.quantityAssumed) issues.push('quantity_assumed');
    if (parsed.quantity === null) issues.push('quantity_invalid');
    if (!parsed.name) issues.push('empty_name');
    const line: ParsedLine = {
      lineNo,
      source,
      kind: 'item',
      section,
      name: parsed.name,
      quantity: parsed.quantity,
      unit: parsed.unit,
      checked: !!checkedMatch,
      notes: parsed.notes,
      issues,
    };
    out.push(line);
    lastItem = line;
    sawContent = true;
  });

  markDuplicates(out, existing);
  return out;
}

function notesText(line: Pick<ParsedLine, 'notes'>): string | undefined {
  return line.notes.length > 0 ? line.notes.join('; ') : undefined;
}

function markDuplicates(lines: ParsedLine[], existing: ExistingItem[]): void {
  const live = existing.filter((e) => !e.isDeleted);
  const existingKeys = new Set(live.map((e) => itemKey(e.name, e.notes)));
  const seen = new Map<string, number>();
  const bases = new Map<string, Set<string>>();
  for (const e of live) {
    const b = baseKey(e.name, e.notes);
    if (b) (bases.get(b) ?? bases.set(b, new Set()).get(b)!).add(itemKey(e.name, e.notes));
  }

  for (const line of lines) {
    if (line.kind !== 'item' || !line.name) continue;
    const key = itemKey(line.name, notesText(line));
    if (!key) continue;
    if (existingKeys.has(key)) {
      line.issues.push('already_on_list');
      line.duplicateOf = 'list';
    } else if (seen.has(key)) {
      line.issues.push('duplicate_in_paste');
      line.duplicateOf = seen.get(key);
    } else {
      seen.set(key, line.lineNo);
    }
    const b = baseKey(line.name, notesText(line));
    if (b) (bases.get(b) ?? bases.set(b, new Set()).get(b)!).add(key);
  }

  // Variant conflicts: same base product, different hard attributes.
  for (const line of lines) {
    if (line.kind !== 'item' || !line.name) continue;
    const b = baseKey(line.name, notesText(line));
    if (b && (bases.get(b)?.size ?? 0) > 1) line.issues.push('variant_conflict');
  }
}

// ─── Review & apply ─────────────────────────────────────────────────────────

export function emptyDecisions(): ImportDecisions {
  return { excluded: new Set(), addDuplicate: new Set(), headingAsItem: new Set() };
}

/** Will this line be imported under these decisions? */
export function willImport(line: ParsedLine, d: ImportDecisions): boolean {
  if (d.excluded.has(line.lineNo)) return false;
  if (line.kind === 'heading') return line.issues.includes('ambiguous_heading') && d.headingAsItem.has(line.lineNo);
  if (line.issues.includes('quantity_invalid') || line.issues.includes('empty_name')) return false;
  if (line.duplicateOf !== undefined && !d.addDuplicate.has(line.lineNo)) return false;
  return true;
}

/**
 * The exact items the preview will create. Applying the import adds these
 * and nothing else, so the result matches what was reviewed.
 */
export function buildImport(lines: ParsedLine[], d: ImportDecisions): ImportedItem[] {
  const out: ImportedItem[] = [];
  let section: string | undefined;
  for (const line of lines) {
    const asItem = willImport(line, d);
    if (line.kind === 'heading' && !asItem) {
      section = line.section;
      continue;
    }
    if (!asItem) continue;
    const parsed = line.kind === 'heading'
      ? { ...parseItemText(line.source), checked: false }
      : { name: line.name, quantity: line.quantity, unit: line.unit, notes: line.notes, checked: line.checked };
    const lineSection = line.kind === 'heading' ? section : line.section;
    const notes = [
      ...parsed.notes,
      ...(lineSection ? [`Section: ${lineSection}`] : []),
    ];
    out.push({
      name: parsed.name,
      quantity: parsed.quantity ?? 1,
      unit: parsed.unit,
      ...(notes.length > 0 ? { notes: notes.join('; ') } : {}),
      isChecked: parsed.checked,
      category: inferCategory(parsed.name),
      lineNo: line.lineNo,
    });
  }
  return out;
}

const ISSUE_LABELS: Record<ImportIssue, string> = {
  quantity_assumed: 'qty 1 assumed — edit after import',
  quantity_invalid: 'invalid quantity — not imported',
  empty_name: 'no item name — not imported',
  ambiguous_heading: 'heading or item? treated as heading',
  duplicate_in_paste: 'duplicate in this paste — skipped',
  already_on_list: 'already on your list — skipped',
  variant_conflict: 'different variant of another line — kept separate',
};

export function describeIssue(issue: ImportIssue): string {
  return ISSUE_LABELS[issue];
}
