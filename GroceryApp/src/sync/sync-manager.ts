/**
 * Sync Manager — coordinates Yjs CRDT sync, WebSocket relay, and WatermelonDB persistence.
 *
 * On app start:
 *  1. Load from WatermelonDB
 *  2. Hydrate Yjs documents
 *  3. Connect to WebSocket relay
 *  4. Observe Yjs changes → encrypt → send via WebSocket
 *  5. Receive remote updates → decrypt → apply to Yjs → persist to WatermelonDB
 */

import * as Y from 'yjs';
import { getDatabase } from '../storage/database';
import { encrypt, decrypt } from '../crypto';
import { YjsWebSocketClient, type WebSocketConfig, type ConnectionState } from './y-websocket';
import {
  getDoc,
  getActiveDocIds,
  hydrateList,
  extractItems,
  extractList,
  destroyDoc,
  destroyAllDocs,
} from './yjs-adapter';
import {
  persistItem,
  persistList,
  loadItemsFromDB,
  loadListsFromDB,
} from '../storage/hydrate';
import type { GroceryItem, GroceryList } from '../types';
import type { EncryptedData } from '../types';

// The registry is written before each snapshot, so a committed snapshot is
// discoverable even if the first materialized list row never reaches disk.
// One queue across lists/managers also serializes registry read/modify/write.
const SNAPSHOT_REGISTRY = 'yjs-state-list-ids';
let persistenceQueue: Promise<void> = Promise.resolve();
const equalBytes = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, i) => byte === right[i]);

// ─── Callbacks ───────────────────────────────────────────────────────────────

export interface SyncCallbacks {
  onConnectionChange?: (state: ConnectionState) => void;
  onSyncError?: (error: Error) => void;
  /** A list that had been reported unreadable now decrypts — retract it. */
  onDecryptRecovered?: (listId: string) => void;
  onRemoteItemsUpdate?: (listId: string, items: GroceryItem[]) => void;
}

// ─── Sync Manager ────────────────────────────────────────────────────────────

export class SyncManager {
  private pendingWrites = new Set<Promise<void>>();
  private generation = 0;
  private recoveryPending = new Set<string>();
  private corruptSnapshots = new Set<string>();
  private recoveryDocs = new Map<string, Y.Doc>();
  private wsClient: YjsWebSocketClient | null = null;
  private config: WebSocketConfig | null = null;
  private callbacks: SyncCallbacks = {};
  private observedDocs = new Map<string, () => void>(); // cleanup functions
  private encryptionKey: Uint8Array | null = null;
  private ready = false;
  private isHydrating = false;

  /**
   * Initialise the sync manager.
   * Must be called after crypto initialisation and after master key is available.
   */
  async init(config: WebSocketConfig, callbacks?: SyncCallbacks, expectedGeneration = this.generation): Promise<void> {
    const generation = expectedGeneration;
    if (generation !== this.generation) return;
    await Promise.allSettled([...this.pendingWrites]);
    if (generation !== this.generation) return;
    if (this.encryptionKey && this.encryptionKey.some((byte, i) => byte !== config.encryptionKey[i])) {
      throw new Error('Restore lists with the new key before connecting');
    }
    const oldClient = this.wsClient;
    if (oldClient) await oldClient.disconnect();
    if (generation !== this.generation) return;
    this.config = config;
    this.callbacks = callbacks ?? {};
    this.encryptionKey = new Uint8Array(config.encryptionKey);

    this.wsClient = new YjsWebSocketClient({ ...config,
      canSendList: (listId) => !this.recoveryPending.has(listId),
    });
    const client = this.wsClient;
    const current = () => generation === this.generation && this.wsClient === client;
    this.wsClient.onStateChange = (state) => {
      if (!current()) return;
      this.callbacks.onConnectionChange?.(state);
    };
    this.wsClient.onError = (err) => {
      if (!current()) return;
      this.callbacks.onSyncError?.(err);
    };
    this.wsClient.onDecryptRecovered = (listId) => {
      if (!current()) return;
      this.callbacks.onDecryptRecovered?.(listId);
    };
    this.wsClient.onRemoteUpdate = (listId, update) => {
      if (!current()) return;
      this.applyRemoteUpdate(listId, update);
    };
    this.wsClient.onNotification = (listId, payload, senderDeviceId) => {
      if (!current()) return;
      this.handleIncomingNotification(listId, payload, senderDeviceId);
    };
    this.wsClient.onReconnected = () => {
      if (!current()) return;
      this.reconcileAll();
    };
    this.wsClient.onSyncRequest = (listId, stateVector) => {
      if (!current()) return;
      this.answerSyncRequest(listId, stateVector);
    };

    client.onRecoveryRequest = (listId, requestId, senderDeviceId) => {
      if (!current() || this.recoveryPending.has(listId) || !getActiveDocIds().includes(listId)) return;
      const doc = getDoc(listId);
      if (doc.store.pendingStructs || doc.store.pendingDs || !extractList(listId)) return;
      client.sendRecoveryState(listId, requestId, senderDeviceId, Y.encodeStateAsUpdate(doc));
    };
    client.onRecoveryResponse = (listId, update) => {
      if (!current()) return;
      this.applyRecoveryState(listId, update).catch(err => this.reportPersistError('failed to persist recovered sync history', err));
    };

    await client.init();
    if (generation !== this.generation || this.wsClient !== client) return;
    this.ready = true;
    this.reportRecoveryPending();
  }

  /**
   * Register a list for sync — observe Yjs changes and send via WebSocket.
   */
  registerList(listId: string): void {
    if (this.observedDocs.has(listId)) return;

    const doc = getDoc(listId);
    const observer = (updates: Uint8Array, origin: any) => {
      // Ignore updates we applied locally (origin is non-null for remote)
      if (origin === 'remote') return;

      // Skip observer during hydration to prevent spurious DB writes
      if (this.isHydrating) return;

      // Send update via WebSocket
      if (this.wsClient && !this.recoveryPending.has(listId)) {
        this.wsClient.sendUpdate(listId, updates);
      }

      // Persist to WatermelonDB. A failed write must reach the user, not just
      // the console (see reportPersistError) — but the rejection itself must
      // stay handled: an unhandled rejection inside a Yjs update observer is
      // worse than a swallowed warning.
      this.persistListToDB(listId).catch((err) => {
        this.reportPersistError('failed to persist after Yjs change', err);
      });
    };

    doc.on('update', observer);

    this.observedDocs.set(listId, () => {
      doc.off('update', observer);
    });
  }

  /**
   * Unregister a list from sync observation.
   */
  unregisterList(listId: string): void {
    const cleanup = this.observedDocs.get(listId);
    if (cleanup) {
      cleanup();
      this.observedDocs.delete(listId);
    }
    destroyDoc(listId);
  }

  /**
   * Disconnect the sync manager.
   */
  async disconnect(): Promise<void> {
    ++this.generation;
    this.encryptionKey = null;
    // Clean up all observers
    this.observedDocs.forEach((cleanup) => cleanup());
    this.observedDocs.clear();

    const client = this.wsClient;
    this.wsClient = null;
    const clientStopped = client?.disconnect();
    this.ready = false;
    await Promise.allSettled([...this.pendingWrites, clientStopped]);
  }

  /**
   * Get the Yjs WebSocket client (for UI status display).
   */
  getClient(): YjsWebSocketClient | null {
    return this.wsClient;
  }

  /**
   * Send a notification to all paired family members.
   * The payload is already encrypted by the caller.
   */
  sendNotification(listId: string, encryptedPayload: EncryptedData): void {
    if (!this.wsClient) {
      console.warn('SyncManager: no WebSocket client, notification dropped');
      return;
    }
    this.wsClient.sendNotification(listId, encryptedPayload);
  }

  // ─── Reconciliation ────────────────────────────────────────────────────
  // Yjs already solves "what did I miss?": a state vector says where a replica
  // is up to, and encodeStateAsUpdate(doc, thatVector) is exactly the delta it
  // lacks. The relay cannot compute that — it only ever holds ciphertext — so
  // reconciliation runs peer to peer, with the relay merely broadcasting the
  // sealed state vector. Without this, any dropped update (queue overflow, an
  // app killed before delivery, relay TTL expiry, a wiped relay volume) is
  // permanent divergence rather than a gap that closes on the next connect.

  /**
   * Publish our state vector for every live document. Called on every
   * (re)connect, once the offline queue has drained so peers reply against
   * our newest state.
   */
  private reconcileAll(): void {
    if (!this.wsClient) return;
    for (const listId of getActiveDocIds()) {
      if (listId.startsWith('__')) continue;
      if (this.recoveryPending.has(listId)) this.wsClient.requestRecovery(listId);
      else this.wsClient.sendStateVector(listId, Y.encodeStateVector(getDoc(listId)));
    }
  }

  /**
   * Answer a peer's state vector with the delta it is missing.
   *
   * Sent as an ordinary `update`, so it reaches every device rather than just
   * the asker. Yjs updates are idempotent and commutative, so the peers that
   * did not need it merge a no-op.
   * ponytail: broadcast rather than unicast — with a family-sized device count
   * the extra traffic is noise; add a `to` field on the relay if it ever isn't.
   */
  private answerSyncRequest(listId: string, stateVector: Uint8Array): void {
    // Never answer for a list we do not already track — getDoc() would create
    // an empty document as a side effect and we would reply with nothing.
    if (!this.wsClient || !getActiveDocIds().includes(listId) || this.recoveryPending.has(listId)) return;
    try {
      const diff = Y.encodeStateAsUpdate(getDoc(listId), stateVector);
      this.wsClient.sendUpdate(listId, diff);
    } catch (err) {
      console.warn('SyncManager: failed to answer sync request', err);
    }
  }

  // ─── Remote Update Handling ────────────────────────────────────────────

  /**
   * Handle an incoming notification from the relay server.
   * Decrypts and displays the notification locally.
   */
  private async handleIncomingNotification(
    listId: string,
    encryptedPayload: EncryptedData,
    _senderDeviceId: string,
  ): Promise<void> {
    try {
      if (!this.encryptionKey) return;
      const { handleIncomingNotification } = await import('../notifications/NotificationManager');
      await handleIncomingNotification(listId, encryptedPayload, this.encryptionKey);
    } catch (err) {
      console.warn('SyncManager: failed to handle incoming notification', err);
    }
  }

  /**
   * Apply a decrypted remote update to a Yjs document.
   */
  private applyRemoteUpdate(listId: string, update: Uint8Array): void {
    if (this.recoveryPending.has(listId)) {
      // Keep remote lineage separate from the value-reconstructed view. No
      // incomplete history can authorize replacing preserved local data.
      let candidate = this.recoveryDocs.get(listId);
      if (!candidate) { candidate = new Y.Doc(); this.recoveryDocs.set(listId, candidate); }
      try { Y.applyUpdate(candidate, update, 'remote'); }
      catch (err) { this.reportPersistError('failed to read legacy recovery history', err); }
      return;
    }
    // A newly discovered list must also observe future edits made on this device.
    this.registerList(listId);
    const doc = getDoc(listId);
    // Apply with origin 'remote' so local observers can distinguish
    Y.transact(doc, () => {
      Y.applyUpdate(doc, update);
    }, 'remote');

    // The visible list store reads this local index, which is not sent over the relay.
    if (extractList(listId)) {
      getDoc('__lists_index__').getMap('listIds').set(listId, true);
    }

    // Notify callbacks
    const items = extractItems(listId);
    this.callbacks.onRemoteItemsUpdate?.(listId, items);

    // Persist updated state to WatermelonDB. Same failure class as the local
    // observer above: a family member's update that fails to persist is lost
    // on restart, so it gets the same user-visible signal.
    this.persistListToDB(listId).catch((err) => {
      this.reportPersistError('failed to persist remote update', err);
    });
  }

  /**
   * Surface a failed WatermelonDB write to the user.
   *
   * A bare console.warn here is exactly how the app previously looked fine
   * while saving nothing (see fresh-install-persistence.test.ts). Sentry is
   * dead in production and error-handler.ts is imported by nothing, so the
   * only signal a user can see is the sync indicator: set the store's error
   * state, which SyncIndicator renders as a red dot plus the message. The
   * copy says "save", not "sync" — the failure is local persistence, and
   * calling it a sync error would mislead.
   */
  private reportPersistError(context: string, err: unknown): void {
    // Keep the console diagnostic alongside the user-visible signal.
    console.warn(`SyncManager: ${context}`, err);
    // Dynamic import: useSyncStore imports syncManager, so a static import
    // here would create a require cycle.
    const generation = this.generation;
    import('../state/useSyncStore')
      .then(({ useSyncStore }) => {
        if (generation !== this.generation) return;
        useSyncStore.setState({
          syncState: 'error',
          error: "Couldn't save recent changes to this device",
          persistenceError: context.includes('persist') ? "Couldn't save recent changes to this device" : useSyncStore.getState().persistenceError,
        });
      })
      .catch(() => {
        // The reporter must never become an unhandled rejection itself.
      });
  }

  // ─── WatermelonDB Persistence ──────────────────────────────────────────

  /**
   * Persist current Yjs state for a list to WatermelonDB.
   */
  private async persistListToDB(listId: string): Promise<void> {
    // No key means nothing can be written at all. This used to `return`
    // cleanly, which is why the ungated ordering — registerList() from the
    // stores before init()/hydrateFromDB() has supplied the key — dropped
    // every write while both .catch sites above stayed silent. Throwing routes
    // it through reportPersistError like any other failed write.
    if (!this.encryptionKey) {
      throw new Error(`no encryption key available; cannot persist list ${listId}`);
    }

    const list = extractList(listId);
    const items = extractItems(listId);
    const snapshot = JSON.stringify({
      version: 1,
      update: Array.from(Y.encodeStateAsUpdate(getDoc(listId))),
      recoveryPending: this.recoveryPending.has(listId),
    });
    // Capture one immutable revision and key before queuing. Its snapshot and
    // all row projections finish together before a newer revision starts.
    const key = new Uint8Array(this.encryptionKey);
    const corrupt = this.corruptSnapshots.has(listId);
    const write = persistenceQueue.catch(() => {}).then(async () => {
      const db = getDatabase();
      const context = `${corrupt ? 'yjs-local-recovery' : 'yjs-state'}:${listId}`;
      const envelope = await encrypt(snapshot, key, context);
      const registry = await db.localStorage.get<string[]>(SNAPSHOT_REGISTRY) ?? [];
      if (!Array.isArray(registry) || registry.some(id => typeof id !== 'string')) {
        throw new Error('Invalid persisted Yjs registry');
      }
      if (!registry.includes(listId)) await db.localStorage.set(SNAPSHOT_REGISTRY, [...registry, listId]);
      await db.localStorage.set(context, envelope);
      if (list) await persistList(list, key);
      for (const item of items) await persistItem(item, key);
    });
    persistenceQueue = write;
    this.pendingWrites.add(write);
    try { await write; } finally { this.pendingWrites.delete(write); }
  }

  private reportRecoveryPending(): void {
    const pending = [...this.recoveryPending];
    const generation = this.generation;
    import('../state/useSyncStore').then(({ useSyncStore }) => {
      if (generation === this.generation) useSyncStore.setState({ recoveryPendingLists: pending });
    }).catch(() => {});
    if (!pending.length) return;
    const message = "Some saved lists need recovery. Keep this device's local data and reconnect an updated family device with the original history; sharing those lists is paused.";
    this.callbacks.onSyncError?.(new Error(message));
    import('../state/useSyncStore').then(({ useSyncStore }) => {
      if (generation === this.generation && this.recoveryPending.size) useSyncStore.setState({ syncState: 'error', error: message });
    }).catch(() => {});
  }

  private reportStorageRecoveryError(message: string, err: unknown): void {
    console.warn('SyncManager: saved history needs recovery', err);
    const generation = this.generation;
    import('../state/useSyncStore').then(({ useSyncStore }) => {
      if (generation === this.generation) useSyncStore.setState({ storageRecoveryError: message });
    }).catch(() => {});
  }

  /** Validate off to the side: failed/partially applied bytes never poison a live doc. */
  private async readSnapshot(listId: string, key: Uint8Array, context: string): Promise<{ update: Uint8Array; recoveryPending: boolean } | null> {
    const envelope = await getDatabase().localStorage.get<EncryptedData>(context);
    if (!envelope) return null;
    const value = JSON.parse(await decrypt(envelope, key, context));
    const bytes = Array.isArray(value) ? value : value?.version === 1 ? value.update : null;
    if (!Array.isArray(bytes) || !bytes.length || bytes.some((x: unknown) => !Number.isInteger(x) || (x as number) < 0 || (x as number) > 255)) {
      throw new Error('Invalid persisted Yjs state');
    }
    const update = new Uint8Array(bytes);
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, update);
      const id = candidate.getMap('meta').get('id');
      const incomplete = candidate.store.pendingStructs || candidate.store.pendingDs;
      if ((id !== undefined && id !== listId) || (id === undefined && !incomplete)) {
        throw new Error('Persisted Yjs state has mismatched or missing list metadata');
      }
      for (const entry of candidate.getArray('items').toArray()) {
        if (!(entry instanceof Y.Map) || typeof entry.get('id') !== 'string' || entry.get('listId') !== listId) {
          throw new Error('Invalid persisted Yjs item');
        }
      }
      return { update, recoveryPending: !Array.isArray(value) && value.recoveryPending === true };
    } finally { candidate.destroy(); }
  }

  /** Hydrate snapshots first; grocery rows are projections or preserved legacy data. */
  async hydrateFromDB(encryptionKey: Uint8Array): Promise<void> {
    const stopped = this.disconnect();
    const generation = this.generation;
    await stopped;
    if (generation !== this.generation) return;
    this.isHydrating = true;
    this.encryptionKey = new Uint8Array(encryptionKey);
    destroyAllDocs();
    const clearing = import('../state/useSyncStore').then(({ useSyncStore }) => {
      if (generation === this.generation) useSyncStore.setState({ storageRecoveryError: null });
    }).catch(() => {});
    await clearing;
    if (generation !== this.generation) return;
    this.recoveryPending.clear();
    this.corruptSnapshots.clear();
    this.recoveryDocs.forEach(doc => doc.destroy());
    this.recoveryDocs.clear();
    try {
      const lists = await loadListsFromDB(encryptionKey);
      if (generation !== this.generation) return;
      let registry: string[] = [];
      try {
        const saved = await getDatabase().localStorage.get<string[]>(SNAPSHOT_REGISTRY) ?? [];
        if (generation !== this.generation) return;
        if (!Array.isArray(saved) || saved.some(id => typeof id !== 'string')) throw new Error('Invalid persisted Yjs registry');
        registry = saved;
      } catch (err) {
        if (generation !== this.generation) return;
        this.reportStorageRecoveryError('Saved list index is unreadable. Existing list data is retained; some saved lists may need recovery.', err);
        // Preserve the unreadable original registry; row-backed lists can
        // still load. No write may implicitly replace that registry.
      }
      const ids = [...new Set([...lists.map(list => list.id), ...registry])];
      const allItems = await loadItemsFromDB(encryptionKey, { listIds: ids });
      if (generation !== this.generation) return;
      const index = getDoc('__lists_index__').getMap('listIds');
      index.clear();
      for (const listId of ids) {
        if (generation !== this.generation) return;
        const list = lists.find(value => value.id === listId);
        const items = allItems.filter(item => item.listId === listId);
        let snapshot: Awaited<ReturnType<SyncManager['readSnapshot']>> = null;
        try {
          snapshot = await this.readSnapshot(listId, encryptionKey, `yjs-state:${listId}`);
        } catch (err) {
          if (generation !== this.generation) return;
          if (!list) {
            // A global legacy registry can reference history encrypted under a
            // previous family key. Never quarantine that ID as a current-family
            // list or block incoming discovery; retain its envelope untouched.
            this.reportStorageRecoveryError('Some saved history cannot be read with this key. Older device data is retained.', err);
            continue;
          }
          // Preserve the corrupt encrypted original for recovery. Local edits
          // use a separate envelope; never silently "repair" it with new IDs.
          this.corruptSnapshots.add(listId);
          this.recoveryPending.add(listId);
          this.reportPersistError(`failed to restore saved sync state for ${listId}`, err);
          try { snapshot = await this.readSnapshot(listId, encryptionKey, `yjs-local-recovery:${listId}`); }
          catch (recoveryError) { if (generation === this.generation) this.reportPersistError('failed to restore local recovery edits', recoveryError); }
        }
        if (generation !== this.generation) return;
        destroyDoc(listId);
        if (snapshot) {
          Y.applyUpdate(getDoc(listId), snapshot.update, 'remote');
          if (snapshot.recoveryPending) this.recoveryPending.add(listId);
        } else if (list) {
          hydrateList(listId, list, items);
          this.recoveryPending.add(listId);
        } else {
          // Registry-first interrupted before snapshot commit: harmless entry.
          continue;
        }
        if (extractList(listId)) index.set(listId, true);
        this.registerList(listId);
      }
    } finally {
      if (generation === this.generation) {
        this.isHydrating = false;
        this.reportRecoveryPending();
      }
    }
  }

  /** A completed, authenticated peer snapshot can restore lost CRDT identities. */
  private async applyRecoveryState(listId: string, update: Uint8Array): Promise<void> {
    if (!this.recoveryPending.has(listId) || !this.encryptionKey) return;
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, update);
      if (candidate.getMap('meta').get('id') !== listId || candidate.store.pendingStructs || candidate.store.pendingDs) return;
      const entries = candidate.getArray<Y.Map<any>>('items').toArray();
      if (entries.some(entry => !(entry instanceof Y.Map) || typeof entry.get('id') !== 'string' || entry.get('listId') !== listId) ||
        new Set(entries.map(entry => entry.get('id'))).size !== entries.length) return;
      // Timestamps cannot establish what happened while this replica was
      // offline. Only semantic equality permits automatic adoption. Divergent
      // rows/tombstones remain visible and encrypted on this device.
      const canonical = (doc: Y.Doc) => {
        const normalize = (value: any): any => {
          if (value === undefined || value === null) return null;
          if (Array.isArray(value)) return value.map(normalize);
          if (typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(key => key !== 'syncStatus')
            .sort().map(key => [key, normalize(value[key])]));
          return value;
        };
        const meta = doc.getMap('meta').toJSON();
        for (const key of ['description', 'storePreference']) if (!meta[key]) delete meta[key];
        const items = doc.getArray<Y.Map<any>>('items').toArray().map(entry => {
          const value = entry.toJSON();
          for (const key of ['notes', 'assignedTo']) if (value[key] == null || value[key] === '') delete value[key];
          return value;
        }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return JSON.stringify(normalize({ meta, items }));
      };
      const currentDoc = getDoc(listId);
      if (canonical(currentDoc) !== canonical(candidate)) { this.reportRecoveryPending(); return; }
      const generation = this.generation;
      const key = new Uint8Array(this.encryptionKey);
      const localState = Y.encodeStateAsUpdate(currentDoc);
      const backup = persistenceQueue.catch(() => {}).then(async () => {
        const original = await getDatabase().localStorage.get<EncryptedData>(`yjs-state:${listId}`);
        const envelope = await encrypt(JSON.stringify({ update: Array.from(localState), original }), key, `yjs-legacy-backup:${listId}`);
        await getDatabase().localStorage.set(`yjs-legacy-backup:${listId}`, envelope);
      });
      persistenceQueue = backup;
      this.pendingWrites.add(backup);
      try { await backup; } finally { this.pendingWrites.delete(backup); }
      if (generation !== this.generation || !this.recoveryPending.has(listId) ||
        !equalBytes(localState, Y.encodeStateAsUpdate(getDoc(listId)))) return;
      this.unregisterList(listId);
      Y.applyUpdate(getDoc(listId), update, 'remote');
      this.recoveryPending.delete(listId);
      this.corruptSnapshots.delete(listId);
      this.registerList(listId);
      this.reportRecoveryPending();
      const accumulated = this.recoveryDocs.get(listId);
      accumulated?.destroy();
      this.recoveryDocs.delete(listId);
      // Live peer edits may arrive while the durable backup awaits storage.
      // Ask again against the adopted lineage rather than wait for reconnect.
      this.wsClient?.sendStateVector(listId, Y.encodeStateVector(getDoc(listId)));
      this.callbacks.onRemoteItemsUpdate?.(listId, extractItems(listId));
      await this.persistListToDB(listId);
    } finally { candidate.destroy(); }
  }

  /** Bootstrap carries this token across async credential lookups to prevent reconnect after reset. */
  getSessionGeneration(): number { return this.generation; }

  /**
   * Check if the sync manager is ready.
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Get the current encryption key (for notification encryption).
   * Returns null if not yet initialized.
   */
  getEncryptionKey(): Uint8Array | null {
    return this.encryptionKey;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const syncManager = new SyncManager();