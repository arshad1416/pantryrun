/**
 * Google Keep import — parse a pasted Keep list into grocery items.
 *
 * Keep has no consumer API, so the person copies the note (Keep: ⋮ → Send →
 * Copy to clipboard) and pastes it here. Accepted shapes:
 *
 *  - Keep's copied text: an optional title line, then one item per line,
 *    usually prefixed "☐ " (open) or "☑ " (ticked). "[ ]", "[x]", "- ",
 *    "* ", "• " and "1." prefixes are accepted too.
 *  - A note from a Google Takeout export (Keep/<note>.json), pasted whole.
 *
 * Headings ("Costco:", "— No Frills —", "## Fortinos", a bare known store
 * name, "Produce:") are never imported as items. Items under a store
 * heading carry the note "From: <Store> list" (other headings: "Section:
 * <X>"); the planner still picks stores by price.
 *
 * Pure: no React Native imports, so it can be unit-tested directly.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ImportedItem {
  name: string;
  quantity: number;
  unit: string;
  notes?: string;
  /** Heading the item was listed under, if any ("Costco", "Produce") */
  heading?: string;
  /** Ticked in Keep — already bought */
  checked: boolean;
}

export type SkipReason = 'ticked' | 'duplicate' | 'already_on_list' | 'not_an_item';

export interface SkippedLine {
  text: string;
  reason: SkipReason;
}

export interface KeepImport {
  title?: string;
  /** Items to add, in list order */
  items: ImportedItem[];
  /** Headings found, in order */
  headings: string[];
  skipped: SkippedLine[];
}

export interface KeepImportOptions {
  /** Import items already ticked in Keep (default false) */
  includeChecked?: boolean;
  /** Names of items already unchecked on the target list — not imported twice */
  existingNames?: string[];
}

/** Upper bound so a pasted novel can't flood the list. */
export const MAX_IMPORT_ITEMS = 200;

// ─── Store headings ─────────────────────────────────────────────────────────

/** Grocers around Waterdown / Hamilton / Burlington, by canonical display name. */
const KNOWN_STORES = [
  'No Frills', 'Fortinos', 'Food Basics', 'FreshCo', 'Metro', 'Walmart',
  'Loblaws', 'Foodland', 'Costco', 'Sobeys', 'Zehrs', 'Real Canadian Superstore',
  'Superstore', 'Farm Boy', "Longo's", 'Shoppers Drug Mart', 'Shoppers',
  'T&T', 'Giant Tiger', 'Dollarama', 'Bulk Barn', 'Nations', 'Adonis',
  "Denninger's", 'Starsky', 'Nations Fresh Foods', 'Healthy Planet',
  'A1 Cash & Carry', 'A1 Cash and Carry',
];

function storeKey(s: string): string {
  return s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9&]+/g, ' ').trim();
}

const STORE_BY_KEY = new Map(KNOWN_STORES.map((s) => [storeKey(s), s]));

/** A known store's display name if `text` is just that store (optionally "… list"). */
function knownStore(text: string): string | null {
  const key = storeKey(text).replace(/\s+(list|run|trip|stuff)$/, '');
  return STORE_BY_KEY.get(key) ?? null;
}

/** Decorations people put around headings: "— X —", "== X ==", "## X", "**X**" */
const DECORATED_RE = /^(?:[-—–=#*_~]{1,}\s*)+(.+?)(?:\s*[-—–=#*_~]{1,})*$/;

interface Heading {
  text: string;
  /** A recognised grocer, not an aisle or section like "Produce" */
  isStore: boolean;
}

/**
 * If `line` is a heading, its cleaned text. Headings: a trailing colon,
 * decoration, or a bare known store name. Only short lines qualify.
 */
function headingOf(line: string, hasMarker: boolean): Heading | null {
  if (line.length > 40) return null;
  const bare = line.replace(/:$/, '').replace(DECORATED_RE, '$1').trim();
  const store = knownStore(bare);
  if (store) return { text: store, isStore: true };
  if (hasMarker) return null; // "☐ something:" is an item with a colon, not a heading
  const isHeading = /:$/.test(line) || (/^[-—–=#*_~]/.test(line) && DECORATED_RE.test(line));
  return isHeading && bare ? { text: bare, isStore: false } : null;
}

// ─── Line markers ───────────────────────────────────────────────────────────

const OPEN_MARKERS = /^(?:☐|□|▢|◻|\[\s?\]|-\s\[\s?\])\s*/;
const TICKED_MARKERS = /^(?:☑|☒|✓|✔|✅|\[[xX✓]\]|-\s\[[xX]\])\s*/;
const BULLET_MARKERS = /^(?:[-*•·]|\d{1,3}[.)])\s+/;

interface Line {
  text: string;
  hasMarker: boolean;
  checked: boolean;
}

function readLine(raw: string): Line {
  const trimmed = raw.trim();
  if (TICKED_MARKERS.test(trimmed)) {
    return { text: trimmed.replace(TICKED_MARKERS, '').trim(), hasMarker: true, checked: true };
  }
  if (OPEN_MARKERS.test(trimmed)) {
    return { text: trimmed.replace(OPEN_MARKERS, '').trim(), hasMarker: true, checked: false };
  }
  if (BULLET_MARKERS.test(trimmed) && !/^-{2,}|^—/.test(trimmed)) {
    return { text: trimmed.replace(BULLET_MARKERS, '').trim(), hasMarker: true, checked: false };
  }
  return { text: trimmed, hasMarker: false, checked: false };
}

// ─── Takeout JSON ───────────────────────────────────────────────────────────

interface TakeoutNote {
  title?: string;
  textContent?: string;
  listContent?: { text?: string; isChecked?: boolean }[];
}

function readTakeout(text: string): { title?: string; lines: Line[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let note: TakeoutNote;
  try {
    note = JSON.parse(trimmed) as TakeoutNote;
  } catch {
    return null;
  }
  const title = note.title?.trim() || undefined;
  if (Array.isArray(note.listContent)) {
    return {
      title,
      lines: note.listContent.map((entry) => ({
        text: String(entry.text ?? '').trim(),
        hasMarker: true,
        checked: !!entry.isChecked,
      })),
    };
  }
  if (typeof note.textContent === 'string') {
    return { title, lines: note.textContent.split(/\r?\n/).map(readLine) };
  }
  return null;
}

// ─── Quantities ─────────────────────────────────────────────────────────────

/** Written unit → stored unit (and a multiplier for "dozen"). */
const UNITS: Record<string, [string, number]> = {
  l: ['L', 1], litre: ['L', 1], litres: ['L', 1], liter: ['L', 1], liters: ['L', 1],
  ml: ['ml', 1],
  kg: ['kg', 1], kgs: ['kg', 1], kilo: ['kg', 1], kilos: ['kg', 1],
  g: ['g', 1], gram: ['g', 1], grams: ['g', 1],
  lb: ['lb', 1], lbs: ['lb', 1], pound: ['lb', 1], pounds: ['lb', 1],
  oz: ['oz', 1],
  pack: ['pack', 1], packs: ['pack', 1], pk: ['pack', 1],
  bag: ['bag', 1], bags: ['bag', 1],
  box: ['box', 1], boxes: ['box', 1],
  can: ['can', 1], cans: ['can', 1],
  bottle: ['bottle', 1], bottles: ['bottle', 1],
  jar: ['jar', 1], jars: ['jar', 1],
  bunch: ['bunch', 1], bunches: ['bunch', 1],
  dozen: ['each', 12],
  ea: ['each', 1], each: ['each', 1], pc: ['each', 1], pcs: ['each', 1], ct: ['each', 1],
};

const NUM = '(\\d+(?:\\.\\d+)?)';
const UNIT = '([a-zA-Z]+)\\.?';
/** "2L milk", "2 bags of coffee", "500g flour" */
const LEADING_UNIT_RE = new RegExp(`^${NUM}\\s*${UNIT}\\s+(?:of\\s+)?(.+)$`);
/** "2 bananas", "2x bananas", "2 × bananas" */
const LEADING_COUNT_RE = new RegExp(`^${NUM}\\s*(?:[xX×]\\s+|\\s+)(.+)$`);
/** "milk 2L", "eggs x2", "coffee beans - 2 bags", "bananas (3)" (parens already removed) */
const TRAILING_RE = new RegExp(`^(.+?)(?:\\s+[xX×]\\s*|\\s*[-:,]\\s*|\\s+)${NUM}\\s*(?:${UNIT})?$`);
/** "a dozen eggs", "dozen eggs" */
const DOZEN_RE = /^(?:an?\s+|1\s+)?dozen\s+(?:of\s+)?(.+)$/i;

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function unitOf(word: string | undefined): [string, number] | null {
  return word ? UNITS[word.toLowerCase()] ?? null : null;
}

/**
 * Split a written list line into name, quantity and unit. Words are kept
 * as typed ("Get Real cereal" stays whole); only a leading or trailing
 * quantity is lifted out.
 */
export function parseListLine(text: string): { name: string; quantity: number; unit: string } {
  const line = text.replace(/\s+/g, ' ').trim();

  const dozen = line.match(DOZEN_RE);
  if (dozen) return { name: capitalize(dozen[1].trim()), quantity: 12, unit: 'each' };

  const leadingUnit = line.match(LEADING_UNIT_RE);
  const lu = unitOf(leadingUnit?.[2]);
  if (leadingUnit && lu) {
    return { name: capitalize(leadingUnit[3].trim()), quantity: parseFloat(leadingUnit[1]) * lu[1], unit: lu[0] };
  }

  const trailing = line.match(TRAILING_RE);
  if (trailing && /\p{L}/u.test(trailing[1])) {
    const tu = unitOf(trailing[3]);
    if (!trailing[3] || tu) {
      const [unit, mult] = tu ?? ['each', 1];
      return { name: capitalize(trailing[1].trim()), quantity: parseFloat(trailing[2]) * mult, unit };
    }
  }

  const leadingCount = line.match(LEADING_COUNT_RE);
  if (leadingCount && /\p{L}/u.test(leadingCount[2])) {
    return { name: capitalize(leadingCount[2].trim()), quantity: parseFloat(leadingCount[1]), unit: 'each' };
  }

  // Nothing written: one of whatever the store sells it in (the app's
  // unit-less convention), not one "each" — "garlic mayo" is a jar.
  return { name: capitalize(line), quantity: 1, unit: '' };
}

// ─── Item text ──────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** "milk (lactose free)" → name "milk", note "lactose free"; "bananas (3)" keeps the count */
function splitParenthetical(text: string): { text: string; note?: string } {
  const notes: string[] = [];
  const stripped = text.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    const t = inner.trim();
    if (/^\d+(?:\.\d+)?\s*[a-zA-Z]*$/.test(t)) return ` ${t}`;
    if (t) notes.push(t);
    return ' ';
  });
  return {
    text: stripped.replace(/\s+/g, ' ').trim(),
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

/** "ketchup - sale only", "pods — sale only" → name + note (a trailing number stays a quantity) */
function splitDashNote(text: string): { text: string; note?: string } {
  const m = text.match(/^(.*?\p{L}.*?)\s+[-—–]\s+(\D.*)$/u);
  return m ? { text: m[1].trim(), note: m[2].trim() } : { text };
}

/** Lines that are clearly not groceries: links, lone emoji/punctuation. */
function isNoise(text: string): boolean {
  return /^https?:\/\//i.test(text) || !/[\p{L}\p{N}]/u.test(text);
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/** Parse a pasted Keep list (copied text or Takeout JSON). */
export function parseKeepList(input: string, opts: KeepImportOptions = {}): KeepImport {
  const takeout = readTakeout(input);
  let title = takeout?.title;
  let lines = takeout?.lines ?? input.split(/\r?\n/).map(readLine);
  lines = lines.filter((l) => l.text.length > 0);

  // Copied text: when the list uses markers, an unmarked first line that
  // isn't a heading is the note's title.
  if (!takeout && lines.length > 1 && !lines[0].hasMarker) {
    const restMarked = lines.slice(1).some((l) => l.hasMarker);
    if (restMarked && !headingOf(lines[0].text, false)) {
      title = lines[0].text;
      lines = lines.slice(1);
    }
  }

  const existing = new Set((opts.existingNames ?? []).map(normalizeName));
  const seen = new Set<string>();
  const items: ImportedItem[] = [];
  const headings: string[] = [];
  const skipped: SkippedLine[] = [];
  let currentHeading: Heading | undefined;

  for (const line of lines) {
    const heading = headingOf(line.text, line.hasMarker);
    if (heading) {
      currentHeading = heading;
      if (!headings.includes(heading.text)) headings.push(heading.text);
      continue;
    }
    if (isNoise(line.text)) {
      skipped.push({ text: line.text, reason: 'not_an_item' });
      continue;
    }
    if (line.checked && !opts.includeChecked) {
      skipped.push({ text: line.text, reason: 'ticked' });
      continue;
    }

    const paren = splitParenthetical(line.text);
    const dash = splitDashNote(paren.text);
    const text = dash.text;
    const note = [paren.note, dash.note].filter(Boolean).join('; ') || undefined;
    const parsed = parseListLine(text);
    if (!/[\p{L}\p{N}]/u.test(parsed.name)) {
      skipped.push({ text: line.text, reason: 'not_an_item' });
      continue;
    }

    const key = normalizeName(parsed.name);
    if (existing.has(key)) {
      skipped.push({ text: line.text, reason: 'already_on_list' });
      continue;
    }
    if (seen.has(key)) {
      skipped.push({ text: line.text, reason: 'duplicate' });
      continue;
    }
    if (items.length >= MAX_IMPORT_ITEMS) break;
    seen.add(key);

    const notes = [
      currentHeading
        ? currentHeading.isStore
          ? `From: ${currentHeading.text} list`
          : `Section: ${currentHeading.text}`
        : null,
      note ?? null,
    ].filter(Boolean).join(' · ');

    items.push({
      name: parsed.name,
      quantity: parsed.quantity,
      unit: parsed.unit,
      checked: line.checked,
      ...(notes ? { notes } : {}),
      ...(currentHeading ? { heading: currentHeading.text } : {}),
    });
  }

  return { ...(title ? { title } : {}), items, headings, skipped };
}
