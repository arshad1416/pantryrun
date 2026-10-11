const fs = require('fs');
const path = require('path');

// State directory override: when RELAY_DATA_DIR is set (the Docker deployment
// sets it to the mounted volume, e.g. /data), encrypted updates live under
// $RELAY_DATA_DIR/data instead of alongside the application code in /app.
const DATA_DIR = process.env.RELAY_DATA_DIR
  ? path.join(process.env.RELAY_DATA_DIR, 'data')
  : path.join(__dirname, 'data');
const UPDATES_FILE = path.join(DATA_DIR, 'encrypted-updates.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Load / save ─────────────────────────────────────────────────────────────
//
// The whole store is one JSON file. It used to be re-read and re-parsed on
// every call, and a parse error returned {} — so the next addUpdate wrote that
// empty object back over the file and erased every family's history. Now:
//
//  - the parsed file is cached and only re-read when its size/mtime changes
//    (another process, or an operator restoring a backup), so reads stop
//    paying a full parse each time;
//  - a file that exists but cannot be read or parsed puts the store into a
//    failed state: a copy is kept aside, reads return nothing, and every
//    write REFUSES (throws) until the file parses again. The server turns
//    that into an error reply, so clients keep their queued updates;
//  - writes go to a temp file that is fsynced and renamed over the original,
//    so a crash mid-write leaves the previous complete file, never a torn one.
//
// Writes stay synchronous, one per stored update: the relay's `ack` now tells
// a client it may delete its queued copy, so an update must be on disk before
// it is acknowledged. Debouncing would open a window where an acknowledged
// update exists only in memory. Clients merge their offline queue into one
// update per list and compact history with snapshots, which is what keeps the
// write rate and the file size down.

let cache = null; // { data, size, mtimeMs }
let loadFailure = null; // { size, mtimeMs, message } while the file is unreadable

function statFile() {
  try {
    const st = fs.statSync(UPDATES_FILE);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function sameStat(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Entries persisted before sequence numbers existed get seq = position + 1.
 * That is deterministic until the next write persists it, and every seq minted
 * from now on is at least Date.now() (see nextSeq), so legacy entries always
 * sort before new ones.
 */
function normalize(data) {
  if (!isPlainObject(data)) throw new Error('top level is not an object');
  for (const familyId of Object.keys(data)) {
    if (!isPlainObject(data[familyId])) throw new Error(`family ${familyId} is not an object`);
    for (const listId of Object.keys(data[familyId])) {
      const entries = data[familyId][listId];
      if (!Array.isArray(entries)) throw new Error(`list ${listId} is not an array`);
      entries.forEach((entry, i) => {
        if (typeof entry.seq !== 'number') entry.seq = i + 1;
      });
    }
  }
  return data;
}

function quarantine(stat, err) {
  const aside = `${UPDATES_FILE}.corrupt-${Date.now()}`;
  let keptAt = aside;
  try {
    fs.copyFileSync(UPDATES_FILE, aside);
  } catch (copyErr) {
    keptAt = `(could not copy aside: ${copyErr.message})`;
  }
  console.error(
    `[encrypted-store] ██ STORED UPDATES ARE UNREADABLE ██ ${UPDATES_FILE}: ${err.message}. ` +
    `A copy was kept at ${keptAt}. The relay will NOT write to this file until it parses ` +
    'again (restore a backup or repair it); live relaying continues, but nothing new is stored.',
  );
  loadFailure = { ...(stat || {}), message: err.message };
}

function loadAllUpdates() {
  let stat;
  try {
    stat = statFile();
  } catch (err) {
    if (!loadFailure) quarantine(null, err);
    return null;
  }
  if (!stat) {
    // Nothing on disk yet (or deleted by an operator): start empty.
    loadFailure = null;
    if (!cache || cache.size !== null) cache = { data: {}, size: null, mtimeMs: null };
    return cache.data;
  }
  if (cache && sameStat(cache, stat)) return cache.data;
  if (loadFailure && sameStat(loadFailure, stat)) return null; // still the same broken file

  try {
    const data = normalize(JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf-8')));
    cache = { data, ...stat };
    if (loadFailure) console.log('[encrypted-store] Stored updates readable again; writes resumed.');
    loadFailure = null;
    return data;
  } catch (err) {
    cache = null;
    quarantine(stat, err);
    return null;
  }
}

function readable() {
  return loadAllUpdates() || {};
}

function writable() {
  const data = loadAllUpdates();
  if (!data) {
    throw new Error(`Encrypted update store is unreadable (${loadFailure?.message}); refusing to overwrite it`);
  }
  return data;
}

function saveAllUpdates(data) {
  const tmp = `${UPDATES_FILE}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, UPDATES_FILE);
  cache = { data, ...statFile() };
}

/** True when the store can accept writes (the file is absent or parses). */
function isWritable() {
  return loadAllUpdates() !== null;
}

// ─── Sequence numbers ────────────────────────────────────────────────────────
//
// Every stored entry carries a per-list `seq`, sent to clients with it. A
// client that has applied everything up to seq N can publish a full-state
// snapshot claiming `coversSeq: N`, and the store then drops exactly those
// entries (see addUpdate). The floor of Date.now() keeps seq monotonic even
// after retention removes a list entirely and it is written again: a client
// that saw the old list's high seq can never claim to cover the new one's.

function nextSeq(entries) {
  const last = entries.length ? entries[entries.length - 1].seq : 0;
  return Math.max(last + 1, Date.now());
}

function getUpdates(familyId, listId) {
  const data = readable();
  const familyData = data[familyId] || {};
  return familyData[listId] || [];
}

function getAllUpdates(familyId) {
  const data = readable();
  return data[familyId] || {};
}

/**
 * Store one opaque update and return the stored entry (with its seq).
 *
 * With `snapshot: true` the update is a family member's full encrypted state
 * for the list (Y.encodeStateAsUpdate). The relay cannot read it, but every
 * writer here is an authenticated family device, so it trusts the claim: the
 * entries the sender says it had already applied (`seq <= coversSeq`) are
 * dropped and the snapshot replaces them. Entries the sender had not seen —
 * including ones that raced the snapshot to the relay — have a higher seq and
 * are kept. This is what bounds history (and the replay a reconnect costs)
 * and what lets retention age out superseded entries without ever dropping
 * a list's only copy.
 */
function addUpdate(familyId, listId, update, { snapshot = false, coversSeq = 0 } = {}) {
  // Validate update structure
  if (!update || typeof update.ciphertext !== 'string' || typeof update.iv !== 'string' || typeof update.tag !== 'string') {
    throw new Error('Invalid update payload format. Expected { ciphertext, iv, tag }');
  }

  const data = writable();
  if (!data[familyId]) {
    data[familyId] = {};
  }
  if (!data[familyId][listId]) {
    data[familyId][listId] = [];
  }

  let entries = data[familyId][listId];
  const seq = nextSeq(entries);
  if (snapshot) {
    const covers = Number.isFinite(coversSeq) ? coversSeq : 0;
    entries = entries.filter((entry) => entry.seq > covers);
  }
  // Only the envelope fields are kept — a client cannot smuggle its own seq,
  // storedAt or snapshot flag in through the payload.
  const entry = { ciphertext: update.ciphertext, iv: update.iv, tag: update.tag, storedAt: Date.now(), seq };
  if (snapshot) entry.snapshot = true;
  entries.push(entry);
  data[familyId][listId] = entries;
  try {
    saveAllUpdates(data);
  } catch (err) {
    // The cached object was mutated; drop it so the next call re-reads what is
    // actually on disk instead of believing the failed write landed.
    cache = null;
    throw err;
  }
  return entry;
}

/**
 * Delete stored updates older than ttlMs. Entries persisted before storedAt
 * stamping existed are stamped now and age out one TTL later (never deleted
 * eagerly). Returns the number of updates removed.
 *
 * A list's newest snapshot and everything after it are never aged out: that
 * is the list's only complete copy on the relay, and deleting it is how a list
 * nobody had edited for 30 days used to vanish for every device that joined
 * later. Clients publish a fresh snapshot on connect whenever a list's stored
 * history is more than that one snapshot, so live lists stay compact; only
 * lists that never had one (pre-snapshot clients, or lists deleted everywhere
 * before one was taken) still expire whole.
 */
function cleanupExpiredUpdates(ttlMs) {
  const now = Date.now();
  let data;
  try {
    data = writable();
  } catch (err) {
    console.warn(`[encrypted-store] Retention sweep skipped: ${err.message}`);
    return 0;
  }
  let removed = 0;
  let changed = false;

  for (const familyId of Object.keys(data)) {
    for (const listId of Object.keys(data[familyId])) {
      const updates = data[familyId][listId];
      let protectedFrom = updates.length;
      for (let i = updates.length - 1; i >= 0; i--) {
        if (updates[i].snapshot) { protectedFrom = i; break; }
      }
      const kept = [];
      updates.forEach((update, i) => {
        if (typeof update.storedAt !== 'number') {
          kept.push({ ...update, storedAt: now });
          changed = true;
        } else if (i < protectedFrom && now - update.storedAt >= ttlMs) {
          removed++;
          changed = true;
        } else {
          kept.push(update);
        }
      });
      if (kept.length === 0) {
        delete data[familyId][listId];
      } else {
        data[familyId][listId] = kept;
      }
    }
    if (Object.keys(data[familyId]).length === 0) {
      delete data[familyId];
    }
  }

  if (changed) {
    try {
      saveAllUpdates(data);
    } catch (err) {
      cache = null;
      throw err;
    }
  }
  return removed;
}

module.exports = {
  getUpdates,
  getAllUpdates,
  addUpdate,
  cleanupExpiredUpdates,
  isWritable,
  UPDATES_FILE,
};
