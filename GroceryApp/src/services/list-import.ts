/**
 * List import — turn a pasted checklist (Google Keep "Copy to clipboard",
 * a plain-text list) or a Google Takeout Keep note (.json) into list items.
 *
 * Google Keep has no consumer API, so nothing here signs in or calls Google:
 * the person pastes text or picks their own Takeout export.
 *
 * Rules, kept small and reviewable:
 *  - "☐ / ☑ / [ ] / [x] / - / * / •" markers are stripped; ☑ ✓ ✔ ✅ [x] mean checked.
 *  - A line naming a store ("Costco", "A1 Cash & Carry:") or ending in ":"
 *    is a heading, not a product. Items under it get it as a store hint —
 *    a hint, not a requirement.
 *  - "Ketchup, sale only" / "gummies (Oct 25)" / "gummies Oct 25" split
 *    into name and note. Rule phrases ("sale only", "any brand") written in the
 *    name move to the note.
 *  - A leading "2", "2x", "1 kg" is a quantity; without one the quantity is
 *    1 and `quantitySpecified` is false so the UI can say it was assumed.
 *  - The original line is kept in `raw`.
 *
 * Pure functions only.
 */

import { SALE_ONLY_RE, SUBSTITUTE_RE } from '../pricing/basket';

export interface ImportedLine {
  /** The line exactly as pasted (markers included). */
  raw: string;
  name: string;
  notes?: string;
  quantity: number;
  unit: string;
  /** False when no quantity was written — 1 is an assumption. */
  quantitySpecified: boolean;
  checked: boolean;
  /** Most recent store heading above this line, if any. */
  storeHint?: string;
}

export interface ImportResult {
  title?: string;
  items: ImportedLine[];
  /** Lines read as store/section headings (not products). */
  headings: string[];
}

export interface ImportOptions {
  /** Extra store names to recognise as headings. */
  storeNames?: string[];
}

/** Stores a Southern Ontario list is likely to be split by. Case-insensitive. */
export const DEFAULT_STORE_HEADINGS = [
  'a1', 'a1 cash & carry', 'a1 cash and carry', 'adonis', 'costco', 'farm boy',
  'food basics', 'fortinos', 'freshco', 'giant tiger', 'loblaws', "longo's",
  'longos', 'metro', 'no frills', 'nofrills', 'real canadian superstore',
  'shoppers', 'shoppers drug mart', 'sobeys', 'superstore', 't&t', 'walmart',
  'zehrs',
];

const MARKER_RE = /^\s*(?:[-*•]\s*)?(\[( |x|X)\]|☐|☑|✓|✔|✅|⬜|□)?\s*/;
const CHECKED_MARKERS = new Set(['[x]', '[X]', '☑', '✓', '✔', '✅']);
/** A trailing date ("Oct 25", "by Nov 3") is a note, not part of the product. */
const TRAILING_DATE_RE =
  /\s+((?:by |before |until )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2})$/i;
const QTY_RE = /^(\d+(?:\.\d+)?)\s*(x|kg|g|lb|lbs|l|ml|pk|pack|packs)?\s+(?=\D)/i;

function normaliseHeading(text: string): string {
  return text.replace(/^[#\s*_-]+|[\s*_:-]+$/g, '').trim();
}

function isHeading(text: string, stores: Set<string>): boolean {
  const bare = normaliseHeading(text);
  if (!bare) return false;
  // "A1 / A1 Cash & Carry" — any alternative naming a store
  if (bare.split(/\s+\/\s+/).some((part) => stores.has(part.toLowerCase()))) return true;
  return /:\s*$/.test(text) && bare.split(/\s+/).length <= 4;
}

/** Split "name, note" / "name (note)" / "name - note", and pull rule phrases out of the name. */
function splitNote(text: string): { name: string; notes?: string } {
  let name = text.trim();
  const notes: string[] = [];

  const paren = name.match(/^(.+?)\s*\(([^)]*)\)\s*$/);
  if (paren) {
    name = paren[1];
    notes.push(paren[2]);
  }
  const sep = name.match(/^(.+?)(?:\s*,\s*|\s+[-–—]\s+)(.+)$/);
  if (sep) {
    name = sep[1];
    notes.unshift(sep[2]);
  }
  const date = name.match(TRAILING_DATE_RE);
  if (date && date.index !== undefined) {
    name = name.slice(0, date.index);
    notes.push(date[1]);
  }
  for (const re of [SALE_ONLY_RE, SUBSTITUTE_RE]) {
    const m = name.match(re);
    if (m && m.index !== undefined && m.index > 0) {
      name = (name.slice(0, m.index) + name.slice(m.index + m[0].length)).trim();
      notes.push(m[0]);
    }
  }
  const note = notes.map((n) => n.trim()).filter(Boolean).join('; ');
  return { name: name.replace(/[\s,;:-]+$/, '').trim(), ...(note ? { notes: note } : {}) };
}

function parseQuantity(text: string): { rest: string; quantity: number; unit: string; specified: boolean } {
  const m = text.match(QTY_RE);
  if (!m) return { rest: text, quantity: 1, unit: '', specified: false };
  const quantity = parseFloat(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  return {
    rest: text.slice(m[0].length),
    quantity: quantity > 0 ? quantity : 1,
    unit: unit === 'x' || unit.startsWith('p') ? '' : unit,
    specified: quantity > 0,
  };
}

function parseEntry(
  raw: string,
  forcedChecked: boolean | undefined,
  stores: Set<string>,
  state: { storeHint?: string; headings: string[] },
): ImportedLine | null {
  if (!raw.trim()) return null;
  const marker = raw.match(MARKER_RE);
  const body = raw.slice(marker?.[0].length ?? 0).trim();
  if (!body) return null;

  if (isHeading(body, stores)) {
    state.storeHint = normaliseHeading(body);
    state.headings.push(state.storeHint);
    return null;
  }

  const checked = forcedChecked ?? CHECKED_MARKERS.has(marker?.[1] ?? '');
  const { rest, quantity, unit, specified } = parseQuantity(body);
  const { name, notes } = splitNote(rest);
  if (!name) return null;
  return {
    raw,
    name,
    ...(notes ? { notes } : {}),
    quantity,
    unit,
    quantitySpecified: specified,
    checked,
    ...(state.storeHint ? { storeHint: state.storeHint } : {}),
  };
}

function storeSet(opts: ImportOptions): Set<string> {
  return new Set([...DEFAULT_STORE_HEADINGS, ...(opts.storeNames ?? [])].map((s) => s.toLowerCase()));
}

/** Parse pasted checklist text. */
export function parseListText(text: string, opts: ImportOptions = {}): ImportResult {
  const stores = storeSet(opts);
  const state: { storeHint?: string; headings: string[] } = { headings: [] };
  const items: ImportedLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEntry(line, undefined, stores, state);
    if (parsed) items.push(parsed);
  }
  return { items, headings: state.headings };
}

interface KeepTakeoutNote {
  title?: string;
  textContent?: string;
  listContent?: { text?: string; isChecked?: boolean }[];
}

/**
 * Parse a Google Takeout Keep note (one `.json` file from the Keep folder).
 * Returns null when the JSON isn't a Keep note.
 */
export function parseKeepTakeout(json: string, opts: ImportOptions = {}): ImportResult | null {
  let note: KeepTakeoutNote;
  try {
    note = JSON.parse(json);
  } catch {
    return null;
  }
  if (!note || typeof note !== 'object') return null;
  const title = note.title?.trim() || undefined;

  if (Array.isArray(note.listContent)) {
    const stores = storeSet(opts);
    const state: { storeHint?: string; headings: string[] } = { headings: [] };
    const items: ImportedLine[] = [];
    for (const entry of note.listContent) {
      const parsed = parseEntry(entry.text ?? '', !!entry.isChecked, stores, state);
      if (parsed) items.push(parsed);
    }
    return { title, items, headings: state.headings };
  }
  if (typeof note.textContent === 'string') {
    return { title, ...parseListText(note.textContent, opts) };
  }
  return null;
}

/** Takeout JSON when it parses as a Keep note, otherwise plain text. */
export function parseImport(input: string, opts: ImportOptions = {}): ImportResult {
  const trimmed = input.trim();
  if (trimmed.startsWith('{')) {
    const keep = parseKeepTakeout(trimmed, opts);
    if (keep) return keep;
  }
  return parseListText(input, opts);
}
