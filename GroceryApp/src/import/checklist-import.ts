/**
 * Checklist import — turn pasted text (a Google Keep checklist copied out of
 * Keep, a notes app, or a plain list) into a REVIEWABLE preview. Nothing is
 * added to the list until the person confirms the preview.
 *
 *  - Checkbox state is preserved (☐ / [ ] unchecked, ☑ / ✔ / [x] checked).
 *    Checked lines default to "skip" — they are already bought.
 *  - Headings ("Costco", "A1 Cash & Carry:") are context, never items. A
 *    store heading becomes a store HINT on the lines under it, not a
 *    mandatory stop.
 *  - Quantities are taken only when written ("1.5 kg", "x8", "2 L"); a line
 *    without one keeps quantity null and is flagged so the person chooses.
 *  - Notes in parentheses or after " - " are kept as notes.
 *  - Duplicates are never silently combined: an exact repeat (in the paste
 *    or already on the list) defaults to skip with a reason; the same product
 *    with different variants ("grapes", "GREEN grapes", "red grapes") is
 *    flagged as a conflict and every line stays separate and editable.
 *  - A plain line in the middle of a checklist is ambiguous (heading or
 *    item?) and defaults to skip until reviewed.
 *  - Any flagged line that would be added must be explicitly reviewed before
 *    the import can be confirmed.
 */

import { deriveBasketLine, parseVariantAttributes, productKey } from '../pricing/list-intent';

export type ImportKind = 'item' | 'heading' | 'ambiguous';
export type ImportAction = 'add' | 'skip';

export interface ImportEntry {
  /** Stable key within one preview. */
  key: string;
  lineNo: number;
  raw: string;
  kind: ImportKind;
  checked: boolean;
  name: string;
  /** null = not written in the source; the person must choose. */
  quantity: number | null;
  unit: string;
  notes: string;
  /** Heading the line sits under, if any. */
  section?: string;
  /** Store named by that heading — context only. */
  storeHint?: string;
  /** Everything the reviewer should look at, in plain language. */
  flags: string[];
  action: ImportAction;
  /**
   * False while a flagged line marked "add" has not been looked at. The
   * import cannot be confirmed until every such line is reviewed.
   */
  reviewed: boolean;
}

export interface ExistingItem {
  id: string;
  name: string;
  isChecked: boolean;
  isDeleted?: boolean;
}

export interface ImportPreview {
  entries: ImportEntry[];
  toAdd: number;
  /** Lines marked "add" that still need a look; import is blocked while > 0. */
  needsReview: number;
}

/** Store names recognised as headings even without a trailing colon. */
const KNOWN_STORES = [
  'costco',
  'a1 cash & carry',
  'a1 cash and carry',
  'no frills',
  'freshco',
  'food basics',
  'walmart',
  'loblaws',
  'metro',
  'fortinos',
  'sobeys',
  'real canadian superstore',
  'superstore',
  'farm boy',
  'longos',
  "longo's",
  't&t',
  'adonis',
  'giant tiger',
  'shoppers drug mart',
];

const UNCHECKED_RE = /^\s*(?:[-*•]\s*)?(?:☐|□|⬜|\[\s\])\s*/;
const CHECKED_RE = /^\s*(?:[-*•]\s*)?(?:☑|☒|✅|✔️?|✓|\[[xX✓]\])\s*/;
const BULLET_RE = /^\s*[-*•]\s+/;

const QTY_UNIT_RE =
  /(?:^|\s)(\d+(?:[.,]\d+)?)\s*(kg|g|lbs?|oz|ml|mL|l|L|litres?|liters?|dozen|pcs?|ea|each|ct|bags?|bunch(?:es)?|box(?:es)?|packs?|bottles?|cans?|jars?|loaf|loaves|tubs?|cartons?|trays?)(?=$|[\s,;)])/;
const COUNT_RE = /(?:^|\s)(?:x\s*(\d+)|(\d+)\s*x)(?=$|[\s,;)])/i;
const LEADING_COUNT_RE = /^(\d+)\s+(?=[A-Za-z])/;

function normaliseUnit(u: string): string {
  const l = u.toLowerCase();
  if (l === 'l' || l.startsWith('litre') || l.startsWith('liter')) return 'L';
  if (l === 'ml') return 'mL';
  if (l === 'lbs') return 'lb';
  if (l === 'pc' || l === 'pcs' || l === 'each' || l === 'ct') return 'ea';
  if (l === 'loaves') return 'loaf';
  if (l === 'bunches') return 'bunch';
  if (l === 'boxes') return 'box';
  return l.replace(/s$/, '');
}

function storeFromHeading(text: string): string | undefined {
  const t = text.replace(/:$/, '').trim();
  return KNOWN_STORES.includes(t.toLowerCase()) ? t : undefined;
}

/** Split "name (note) - note" into name and notes. */
function splitNotes(text: string): { name: string; notes: string[] } {
  const notes: string[] = [];
  let name = text.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    if (inner.trim()) notes.push(inner.trim());
    return ' ';
  });
  const dash = name.match(/\s+[-–—]\s+(.+)$/);
  if (dash) {
    notes.push(dash[1]!.trim());
    name = name.slice(0, dash.index);
  }
  return { name: name.replace(/\s{2,}/g, ' ').trim(), notes };
}

function parseItemText(text: string): { name: string; quantity: number | null; unit: string; notes: string } {
  const { name: base, notes } = splitNotes(text);
  let name = base;
  let quantity: number | null = null;
  let unit = '';

  const qu = name.match(QTY_UNIT_RE);
  if (qu) {
    quantity = parseFloat(qu[1]!.replace(',', '.'));
    unit = normaliseUnit(qu[2]!);
    name = (name.slice(0, qu.index) + ' ' + name.slice(qu.index! + qu[0].length)).trim();
  } else {
    const c = name.match(COUNT_RE);
    if (c) {
      quantity = parseInt(c[1] ?? c[2]!, 10);
      unit = 'ea';
      name = (name.slice(0, c.index) + ' ' + name.slice(c.index! + c[0].length)).trim();
    } else {
      const lead = name.match(LEADING_COUNT_RE);
      if (lead) {
        quantity = parseInt(lead[1]!, 10);
        unit = 'ea';
        name = name.slice(lead[0].length).trim();
      }
    }
  }
  return { name: name.replace(/\s{2,}/g, ' ').trim(), quantity, unit, notes: notes.join('; ') };
}

function identity(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
}

/** Build a review preview from pasted text. Pure: nothing is written. */
export function previewImport(text: string, existing: ExistingItem[] = []): ImportPreview {
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  const hasCheckboxes = rawLines.some((l) => UNCHECKED_RE.test(l) || CHECKED_RE.test(l));
  const entries: ImportEntry[] = [];
  let section: string | undefined;
  let storeHint: string | undefined;
  let seenItem = false;

  rawLines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const lineNo = i + 1;
    const key = `L${lineNo}`;

    let checked = false;
    let body: string | null = null;
    if (CHECKED_RE.test(raw)) {
      checked = true;
      body = raw.replace(CHECKED_RE, '');
    } else if (UNCHECKED_RE.test(raw)) {
      body = raw.replace(UNCHECKED_RE, '');
    } else if (!hasCheckboxes) {
      body = raw.replace(BULLET_RE, '');
    }

    const headingStore = storeFromHeading(line);
    const looksLikeHeading = line.endsWith(':') || !!headingStore || (!seenItem && hasCheckboxes && body === null);

    if (body === null || (looksLikeHeading && !(UNCHECKED_RE.test(raw) || CHECKED_RE.test(raw)))) {
      if (looksLikeHeading) {
        section = line.replace(/:$/, '').trim();
        storeHint = headingStore;
        entries.push({
          key, lineNo, raw, kind: 'heading', checked: false, name: section, quantity: null, unit: '', notes: '',
          flags: headingStore ? [`store heading — used as a hint for the lines below, not a required stop`] : ['heading — not an item'],
          action: 'skip',
          reviewed: true,
        });
        return;
      }
      entries.push({
        key, lineNo, raw, kind: 'ambiguous', checked: false, ...parseItemText(line), section, storeHint,
        flags: ['no checkbox — is this a heading or an item? Skipped until you choose'],
        action: 'skip',
        reviewed: false,
      });
      return;
    }

    seenItem = true;
    const parsed = parseItemText(body.trim());
    const flags: string[] = [];
    if (parsed.quantity === null) flags.push('no quantity written — choose one (1 is only a planning assumption)');
    if (parsed.quantity === 0) flags.push('quantity 0 — will not be bought');
    if (checked) flags.push('checked in the source — already bought');
    entries.push({
      key, lineNo, raw, kind: 'item', checked, ...parsed, section, storeHint, flags,
      action: checked ? 'skip' : 'add',
      reviewed: false,
    });
  });

  flagDuplicates(entries, existing);
  for (const e of entries) if (e.flags.length === 0) e.reviewed = true;
  return summarise(entries);
}

function flagDuplicates(entries: ImportEntry[], existing: ExistingItem[]): void {
  const onList = new Map<string, ExistingItem>();
  for (const it of existing) {
    if (!it.isDeleted && !it.isChecked) onList.set(identity(it.name), it);
  }
  const firstByIdentity = new Map<string, ImportEntry>();
  const byProduct = new Map<string, ImportEntry[]>();

  for (const e of entries) {
    if (e.kind === 'heading') continue;
    const id = identity(e.name);
    if (onList.has(id)) {
      e.flags.push(`already on your list as "${onList.get(id)!.name}" — skipped so it is not counted twice`);
      e.action = 'skip';
    }
    const first = firstByIdentity.get(id);
    if (first && e.kind === 'item') {
      e.flags.push(`repeats line ${first.lineNo} — skipped; nothing is combined automatically`);
      e.action = 'skip';
    } else if (!first) {
      firstByIdentity.set(id, e);
    }
    const pk = productKey(e.name);
    if (pk) byProduct.set(pk, [...(byProduct.get(pk) ?? []), e]);
  }

  for (const group of byProduct.values()) {
    const variants = new Set(group.map((e) => parseVariantAttributes(e.name).sort().join('+')));
    const names = new Set(group.map((e) => identity(e.name)));
    if (variants.size > 1 && names.size > 1) {
      const list = [...new Set(group.map((e) => e.name))].join(' / ');
      for (const e of group) e.flags.push(`conflicting variants (${list}) — kept separate; review which you need`);
    }
  }
}

function summarise(entries: ImportEntry[]): ImportPreview {
  return {
    entries,
    toAdd: entries.filter((e) => e.action === 'add').length,
    needsReview: entries.filter((e) => e.action === 'add' && !e.reviewed).length,
  };
}

/** Recompute counts after the person edits entries in the preview. */
export function refreshPreview(entries: ImportEntry[]): ImportPreview {
  return summarise(entries);
}

export interface ImportedItem {
  name: string;
  quantity: number;
  /** '' when no quantity was written — the planner labels it an assumption. */
  unit: string;
  notes: string;
  isChecked: boolean;
}

/** Items to add for the entries marked "add". */
export function itemsToAdd(entries: ImportEntry[]): ImportedItem[] {
  return entries
    .filter((e) => e.action === 'add' && e.kind !== 'heading' && e.name.trim())
    .map((e) => {
      const notes = [e.notes, e.storeHint ? `store hint: ${e.storeHint}` : ''].filter(Boolean).join('; ');
      return {
        name: e.name.trim(),
        quantity: e.quantity ?? 1,
        unit: e.quantity == null ? '' : e.unit,
        notes,
        isChecked: e.checked,
      };
    });
}

/** What the planner will understand from an entry — shown in the preview. */
export function describeIntent(e: ImportEntry): string[] {
  if (e.kind === 'heading') return [];
  const line = deriveBasketLine({
    id: e.key,
    name: e.name,
    quantity: e.quantity ?? 1,
    unit: e.quantity == null ? '' : e.unit,
    notes: e.notes,
  });
  const out: string[] = [];
  if (line.requirements.length) out.push(`must be ${line.requirements.map((r) => r.attr.toUpperCase()).join(', ')}`);
  if (line.saleOnly) out.push('sale only');
  if (line.notes) out.push(`note: ${line.notes}`);
  if (e.storeHint) out.push(`hint: ${e.storeHint}`);
  return out;
}
