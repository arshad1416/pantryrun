/**
 * Mock for @nozbe/watermelondb.
 * Provides a minimal Database class for testing.
 *
 * This mock deliberately reproduces two constraints that the real library
 * enforces at runtime, because a permissive mock previously let broken
 * persistence code pass the whole suite:
 *
 *   1. Writes must happen inside a Writer. Real `Collection.create()` and
 *      `Model.update()` call `Database._ensureInWriter()`, which throws via
 *      `invariant()` when no `database.write()` block is on the stack.
 *   2. `syncStatus` is a read-only accessor on the base `Model` (it reads
 *      `_raw._status`). It has no setter, so assigning to it throws a
 *      TypeError under strict mode — which is how app code is compiled.
 */

const tables = new Map<string, Map<string, any>>();

/** Depth of nested `database.write()` blocks currently on the stack. */
let writerDepth = 0;

function ensureInWriter(debugName: string): void {
  if (writerDepth === 0) {
    throw new Error(
      `${debugName} can only be called from inside of a Writer. See docs for more details.`,
    );
  }
}

/**
 * Prototype for stored records. `syncStatus` is defined as a getter with no
 * setter, mirroring the real base Model.
 */
const recordPrototype = {
  get syncStatus(): string {
    return (this as any)._raw?._status ?? 'created';
  },
};

function newRecord(table: string): any {
  const record: any = Object.create(recordPrototype);
  record._raw = {};

  // Non-enumerable so the record still spreads/serializes like plain data.
  Object.defineProperty(record, 'update', {
    value: async (fn: (r: any) => void) => {
      ensureInWriter('Model.update()');
      fn(record);
      return record;
    },
    enumerable: false,
  });
  Object.defineProperty(record, 'markAsDeleted', {
    value: async () => {
      ensureInWriter('Model.markAsDeleted()');
      record._raw = { ...(record._raw || {}), isDeleted: true };
    },
    enumerable: false,
  });
  Object.defineProperty(record, 'table', { value: table, enumerable: false });

  return record;
}

class Query {
  private table: string;
  private _where: any[] = [];

  constructor(table: string) {
    this.table = table;
  }

  where(...args: any[]): Query {
    this._where.push(args);
    return this;
  }

  async fetch(): Promise<any[]> {
    const items = tables.get(this.table);
    if (!items) return [];
    // Return the live records themselves — they already carry update() and
    // markAsDeleted(), and returning copies would lose the syncStatus accessor.
    let rows = Array.from(items.values()).filter((item) => !item._raw?.isDeleted);

    // Honour Q.where. This used to be ignored entirely, which made
    // `query(Q.where('id', x)).fetch()` return the WHOLE table — so every
    // persist* saw a non-empty `existing` as soon as one row existed and took
    // the update branch, silently overwriting an unrelated record instead of
    // creating a new one. Any test persisting two rows was testing a fiction.
    for (const clause of this._where) {
      // `where()` receives either the clause object itself (from query(...))
      // or a spread args array (from a chained .where(...)).
      const c = Array.isArray(clause) ? clause[0] : clause;
      const { field, value } = (c ?? {}) as { field?: string; value?: unknown };
      if (!field) continue;
      rows = rows.filter((r) => {
        const actual = field === 'id' ? (r._raw?.id ?? r.id) : r[camel(field)];
        return actual === value;
      });
    }
    return rows;
  }
}

/** snake_case column name -> camelCase record property, as the real lib does. */
const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

class Collection {
  private table: string;

  constructor(table: string) {
    this.table = table;
  }

  query(...args: any[]): Query {
    const q = new Query(this.table);
    // Apply the clauses. These used to be DISCARDED, so
    // `query(Q.where('id', x)).fetch()` returned the entire table — which made
    // every persist*() see a non-empty `existing` as soon as one row existed
    // and take the update branch, overwriting an unrelated record instead of
    // creating a new one. Two rows could never coexist in a test.
    for (const clause of args) {
      if (clause) q.where(clause);
    }
    return q;
  }

  async create(fn: (r: any) => void): Promise<any> {
    ensureInWriter('Collection.create()');
    if (!tables.has(this.table)) {
      tables.set(this.table, new Map());
    }
    const items = tables.get(this.table)!;
    const record = newRecord(this.table);
    fn(record);
    // Auto-generate an id when the creator didn't set one (matches real
    // WatermelonDB behavior of assigning a random id on create)
    if (!record.id && !record._raw.id) {
      record.id = `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    // Real WatermelonDB exposes _raw.id as record.id — mirror both ways
    record.id = record.id ?? record._raw.id;
    record._raw.id = record._raw.id ?? record.id;
    items.set(record._raw?.id || record.id, record);
    return record;
  }
}

const localValues = new Map<string, any>();

export class Database {
  localStorage = {
    get: async (key: string) => localValues.get(key),
    set: async (key: string, value: any) => { localValues.set(key, value); },
    remove: async (key: string) => { localValues.delete(key); },
  };
  constructor(_opts?: any) {}

  get(table: string): Collection {
    return new Collection(table);
  }

  async write<T>(fn: () => Promise<T>): Promise<T> {
    writerDepth += 1;
    try {
      return await fn();
    } finally {
      writerDepth -= 1;
    }
  }

  /** Mirrors the real API: must be called from inside a Writer. */
  async unsafeResetDatabase(): Promise<void> {
    ensureInWriter('Database.unsafeResetDatabase()');
    tables.clear();
    localValues.clear();
  }
}

export const Q = {
  where: (field: string, value: any) => ({ field, value }),
};

// ─── Schema / migration / adapter / model shims ─────────────────────────────
// jest moduleNameMapper points every @nozbe/watermelondb subpath at this file,
// so it must also cover schema helpers, migrations, decorators, and the
// SQLite adapter used by src/storage/database.ts.

export const appSchema = (x: any) => x;
export const tableSchema = (x: any) => x;
export const schemaMigrations = (x: any) => x;
export const addColumns = (x: any) => x;
export const createTable = (x: any) => x;

export class Model {
  static table: string;
  _raw: any = {};

  /** Read-only in the real library — no setter, assignment throws in strict mode. */
  get syncStatus(): string {
    return this._raw?._status ?? 'created';
  }
}

// Legacy TS decorators — models.ts applies them imperatively via
// Object.defineProperty(proto, key, decorator(...)), so the mocks must return
// a valid descriptor (plain value prop is fine; mock records are plain data).
const mockDescriptor = (): PropertyDescriptor => ({
  configurable: true,
  enumerable: true,
  writable: true,
  value: undefined,
});
export const field = (_name: string) => mockDescriptor;
export const relation = (_table: string, _key: string) => mockDescriptor;
export const readonly = (_target: any, _key: string) => {};
export const date = (_name: string) => mockDescriptor;

// Default export doubles as SQLiteAdapter for `adapters/sqlite`
export default class SQLiteAdapter {
  constructor(_opts?: any) {}
}

export function _resetDB(): void {
  tables.clear();
  localValues.clear();
  writerDepth = 0;
}

export function _getTable(table: string): Map<string, any> {
  return tables.get(table) || new Map();
}
