/**
 * WebSocket client for encrypted Yjs sync with the relay server.
 *
 * Connects to the zero-knowledge relay, sends/receives encrypted Yjs updates,
 * handles reconnection with exponential backoff, and maintains an offline queue.
 *
 * Flow:
 *  1. Yjs document changes → serialize update → encrypt with libsodium → send via WebSocket
 *  2. Receive encrypted update from WebSocket → decrypt → apply to Yjs document
 *  3. Offline: queue pending updates in memory; flush when connection restores
 */

// ─── Lazy sodium import ──────────────────────────────────────────────────────
// Deferred to avoid SIGSEGV during module evaluation (see crypto/index.ts).
let sodium: any = null;

async function getSodium(): Promise<any> {
  if (!sodium) {
    const mod = await import('react-native-libsodium');
    sodium = mod.default;
  }
  return sodium;
}
import * as Y from 'yjs';
import type { EncryptedData } from '../types';
import { encrypt, decrypt, DecryptFailureError } from '../crypto';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface WebSocketConfig {
  /** WebSocket relay server URL (e.g. 'ws://localhost:8080') */
  url: string;
  /** Family ID for routing updates to the right group */
  familyId: string;
  /** Device ID for this client instance */
  deviceId: string;
  /** Encryption key for Yjs updates (shared family key) */
  encryptionKey: Uint8Array;
  /** Relay token obtained from POST /enroll (used for auth, never in URL) */
  relayToken?: string;
  /**
   * Explicit opt-in for unauthenticated connections (test environments only).
   * When false (default) and relayToken is missing, init() throws.
   * When true, skips auth and sends identity directly.
   */
  allowUnauthenticated?: boolean;
  /** Value-only lists must not publish reconstructed deltas or drain old queues. */
  canSendList?: (listId: string) => boolean;
  /** Maximum reconnect delay in ms (default: 30s) */
  maxReconnectDelay?: number;
  /** Initial reconnect delay in ms (default: 1s) */
  initialReconnectDelay?: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface OfflineEntry {
  update: Uint8Array;
  listId: string;
  timestamp: number;
  /** WatermelonDB row id when this entry is also persisted to disk. */
  persistedId?: string | null;
  /**
   * Set when the entry was evicted from the in-memory queue. Eviction can win
   * the race against its own disk write (persistedId is still null, so there
   * is nothing to delete yet), and the row would then sit on disk forever:
   * restorePersistedQueue stops at MAX_QUEUE_SIZE before ever reaching it.
   * persistEntry checks this flag and deletes the row when the write lands.
   */
  dropped?: boolean;
}

// ─── WebSocket Sync Client ───────────────────────────────────────────────────

export const MAX_QUEUE_SIZE = 1000;

/**
 * XChaCha20-Poly1305 authentication tag length.
 *
 * Hardcoded, not read from sodium. react-native-libsodium's native surface
 * (lib.native.d.ts) declares crypto_aead_xchacha20poly1305_ietf_NPUBBYTES but
 * never declares ..._ietf_ABYTES, so on device that constant is undefined:
 * `length - undefined` is NaN, `slice(0, NaN)` is empty and `slice(NaN)` is the
 * whole buffer, which shipped every envelope as `ciphertext: ""` with cipher||
 * tag in `tag` — and loadQueueEntries() then discarded every persisted offline
 * edit, because base64 of a zero-length array is "". The JS-only surface and
 * the Jest mock both declare it, so nothing failed in CI.
 * crypto/index.ts hardcodes the same value for the same reason.
 */
const ABYTES = 16;

// Native libsodium has to_string but no from_string. Escape JSON to ASCII so
// recovery control messages need no TextEncoder/polyfill/native-only API.
function encodeRecoveryMessage(value: unknown): Uint8Array {
  const json = JSON.stringify(value).replace(/[^\x20-\x7e]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return Uint8Array.from(json, character => character.charCodeAt(0));
}

export class YjsWebSocketClient {
  private config: WebSocketConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private state: ConnectionState = 'disconnected';
  private offlineQueue: OfflineEntry[] = [];
  private encryptKey: Uint8Array;
  /** Lists already reported as undecryptable — see reportDecryptFailure. */
  private readonly reportedDecryptFailures = new Set<string>();
  private ready = false;
  private disposed = false;
  private authPending = true; // true until auth_ack received
  /** Latched when the relay answers sync_request with "unknown message type". */
  private reconciliationUnsupported = false;
  private storageOperations = new Set<Promise<unknown>>();
  private initializing: Promise<void> | null = null;
  private heldCount = 0;
  private recoveryRequests = new Map<string, string>();
  private _ackTimeout: ReturnType<typeof setTimeout> | null = null;

  // Callbacks
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
  /** A previously-unreadable list decrypted cleanly again. */
  onDecryptRecovered?: (listId: string) => void;
  /** Called when a remote update is received and applied */
  onRemoteUpdate?: (listId: string, update: Uint8Array) => void;
  /** Called when the offline queue is drained */
  onQueueDrained?: () => void;
  /** Called when a notification message is received from the relay */
  onNotification?: (listId: string, payload: EncryptedData, senderDeviceId: string) => void;
  /**
   * A peer published its Yjs state vector for `listId` and wants whatever it
   * is missing. Answer with Y.encodeStateAsUpdate(doc, stateVector).
   */
  onSyncRequest?: (listId: string, stateVector: Uint8Array, senderDeviceId: string) => void;
  /**
   * The connection is up and the offline queue has been flushed — the moment
   * to publish our own state vectors and find out what we missed.
   */
  onReconnected?: () => void;
  onRecoveryRequest?: (listId: string, requestId: string, senderDeviceId: string) => void;
  onRecoveryResponse?: (listId: string, update: Uint8Array) => void;

  constructor(config: WebSocketConfig) {
    this.config = config;
    this.encryptKey = new Uint8Array(config.encryptionKey);
  }

  /**
   * Initialise libsodium and connect.
   */
  init(): Promise<void> {
    const initializing = this.initialize();
    this.initializing = initializing;
    return initializing;
  }

  private async initialize(): Promise<void> {
    await getSodium(); // triggers lazy import + sets module-level `sodium`
    await sodium.ready;
    if (this.disposed) return;
    this.ready = true;
    // Restore updates that were queued offline in a previous process life —
    // without this, killing the app loses edits that never reached the relay.
    await this.restorePersistedQueue();
    if (!this.disposed) this.connect();
  }

  /**
   * Load queue entries persisted by a previous session into the in-memory
   * queue. Entries that no longer decrypt (e.g. key changed after a family
   * reset) are dropped from disk.
   */
  private async restorePersistedQueue(): Promise<void> {
    try {
      const { loadQueueEntries, deleteQueueEntries } = await import('./offline-queue-store');
      if (this.disposed) return;
      const persisted = await loadQueueEntries();
      if (this.disposed || persisted.length === 0) return;
      const { getDatabase } = await import('../storage/database');
      if (this.disposed) return;
      const db = getDatabase();
      const heldIds = await db.localStorage.get<string[]>('yjs-held-queue-ids') ?? [];
      if (this.disposed) return;
      if (!Array.isArray(heldIds) || heldIds.some(id => typeof id !== 'string')) {
        this.onError?.(new Error('Saved pending-change recovery index is unreadable; delivery paused.'));
        return;
      }
      const held = new Set(heldIds);
      for (const entry of persisted) {
        if (this.config.canSendList?.(entry.listId) === false) held.add(entry.id);
      }
      // Persist the hold BEFORE any queue can drain. Adoption of a recovered
      // list must never release old deltas with unknown dependencies later.
      if (held.size !== heldIds.length) await db.localStorage.set('yjs-held-queue-ids', [...held]);
      if (this.disposed) return;
      this.heldCount = persisted.filter(entry => held.has(entry.id)).length;

      const undecryptable: string[] = [];
      for (const entry of persisted) {
        if (held.has(entry.id)) continue;
        if (this.offlineQueue.length >= MAX_QUEUE_SIZE) break;
        try {
          const update = this.decryptUpdate(entry.payload, entry.listId);
          this.offlineQueue.push({
            update,
            listId: entry.listId,
            timestamp: entry.createdAt,
            persistedId: entry.id,
          });
        } catch {
          undecryptable.push(entry.id);
        }
      }
      if (undecryptable.length > 0) {
        // These are edits the user made that will never reach the family. That
        // is data loss, so it gets the same user-visible channel as a queue
        // overflow rather than a console line nobody reads.
        this.onError?.(new Error(
          `${undecryptable.length} queued offline update(s) could no longer be decrypted ` +
          `and were discarded. Those edits were not shared with your family.`,
        ));
        await deleteQueueEntries(undecryptable);
      }
      if (this.offlineQueue.length > 0) {
        console.log(`YjsWebSocket: restored ${this.offlineQueue.length} offline update(s) from disk`);
      }
    } catch (err) {
      console.warn('YjsWebSocket: failed to restore persisted queue', err);
      if (!this.disposed) this.onError?.(new Error('Saved pending changes could not be restored; their delivery is paused.'));
    }
  }

  // ─── Connection Management ──────────────────────────────────────────────

  private get reconnectDelay(): number {
    const initial = this.config.initialReconnectDelay ?? 1000;
    const max = this.config.maxReconnectDelay ?? 30_000;
    // Exponential backoff with jitter
    const delay = Math.min(initial * Math.pow(2, this.reconnectAttempt), max);
    const jitter = Math.random() * 0.3 * delay;
    return delay + jitter;
  }

  /**
   * Connect (or reconnect) to the relay server.
   */
  connect(): void {
    if (this.disposed) return;
    if (this.ws?.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1) ||
        this.ws?.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.CONNECTING : 0)) {
      return;
    }

    this.setState('connecting');
    this.ws = new WebSocket(this.config.url);
    const socket = this.ws;
    const current = () => !this.disposed && this.ws === socket;

    this.ws.onopen = () => {
      if (!current()) return;
      this.reconnectAttempt = 0;
      // State stays 'connecting' until auth_ack received
      // (prevents sending updates before authentication)

      if (this.config.relayToken) {
        // Normal flow: authenticate via relay token
        this.authPending = true;
        // Client-side timeout: if no auth_ack within 10s, disconnect
        const ackTimeout = setTimeout(() => {
          if (this.authPending) {
            this.onError?.(new Error('Authentication timeout: server did not respond within 10s'));
            this.disconnect();
          }
        }, 10_000);
        this._ackTimeout = ackTimeout;
        this.sendMessage({
          type: 'auth',
          relayToken: this.config.relayToken,
        });
      } else if (this.config.allowUnauthenticated) {
        // Test mode: skip auth, send identity directly
        this.authPending = false;
        this.setState('connected');
        this.sendMessage({
          type: 'identity',
          familyId: this.config.familyId,
          deviceId: this.config.deviceId,
        });
        this.flushOfflineQueue();
        this.onReconnected?.();
      } else {
        // Production: missing relayToken is a fatal error
        this.onError?.(new Error(
          'No relay token available. Call enrollWithRelay() first or set allowUnauthenticated=true in tests.',
        ));
        this.disconnect();
      }
    };

    this.ws.onmessage = async (event) => {
      if (!current()) return;
      try {
        const data = JSON.parse(event.data as string) as RelayMessage;
        await this.handleMessage(data);
      } catch (err) {
        console.warn('YjsWebSocket: failed to handle message', err);
      }
    };

    this.ws.onerror = (event) => {
      if (!current()) return;
      console.warn('YjsWebSocket: connection error', event);
      this.setState('error');
      this.onError?.(new Error('WebSocket connection error'));
    };

    this.ws.onclose = () => {
      if (!current()) return;
      this.setState('disconnected');
      this.scheduleReconnect();
    };
  }

  /**
   * Disconnect and clean up.
   */
  async disconnect(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._ackTimeout) {
      clearTimeout(this._ackTimeout);
      this._ackTimeout = null;
    }
    this.reconnectAttempt = 0;
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
    this.recoveryRequests.clear();
    await Promise.allSettled([this.initializing, ...this.storageOperations]);
    // In-flight eviction cleanup can enqueue another storage operation.
    while (this.storageOperations.size) await Promise.allSettled([...this.storageOperations]);
  }

  private scheduleReconnect(): void {
    if (this.disposed) return; // never reconnect after explicit disconnect
    if (this.reconnectTimer) return; // already scheduled
    const delay = this.reconnectDelay;
    console.log(`YjsWebSocket: reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt + 1})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      this.connect();
    }, delay);
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(newState);
    }
  }

  // ─── Sending Updates ───────────────────────────────────────────────────

  /**
   * Send a Yjs update for a specific list to the relay server.
   * If offline, enqueue for later delivery.
   */
  sendUpdate(listId: string, update: Uint8Array): void {
    if (this.disposed || this.config.canSendList?.(listId) === false) return;
    if (!this.ready) {
      console.warn('YjsWebSocket: libsodium not ready, enqueueing');
      this.enqueueOffline(update, listId);
      return;
    }

    if (this.state !== 'connected' || !this.ws) {
      // Offline — queue it
      this.enqueueOffline(update, listId);
      return;
    }

    try {
      const encrypted = this.encryptUpdate(update, listId);
      this.sendMessage({
        type: 'update',
        familyId: this.config.familyId,
        deviceId: this.config.deviceId,
        listId,
        payload: encrypted,
      });
    } catch (err) {
      console.warn('YjsWebSocket: failed to encrypt/send update', err);
      this.enqueueOffline(update, listId);
    }
  }

  /**
   * Send an encrypted notification to the relay server.
   * Notifications are best-effort — if offline, the notification is dropped.
   */
  sendNotification(listId: string, encryptedPayload: EncryptedData): void {
    if (this.state !== 'connected' || !this.ws) {
      console.warn('YjsWebSocket: offline, notification dropped (non-critical)');
      return; // Notifications are best-effort — don't queue
    }

    this.sendMessage({
      type: 'notification',
      familyId: this.config.familyId,
      deviceId: this.config.deviceId,
      listId,
      payload: encryptedPayload,
    });
  }

  /**
   * Publish our Yjs state vector for a list so peers can send back exactly
   * what we are missing. This is the only mechanism by which a dropped update
   * — queue overflow, an app kill before delivery, relay TTL expiry — is ever
   * recovered; without it every drop is permanent divergence.
   *
   * Best-effort like notifications: if we are offline there is nobody to
   * answer, and the next connect will publish again.
   */
  sendStateVector(listId: string, stateVector: Uint8Array): void {
    if (this.reconciliationUnsupported) return;
    if (!this.ready || this.state !== 'connected' || !this.ws) return;
    try {
      this.sendMessage({
        type: 'sync_request',
        familyId: this.config.familyId,
        deviceId: this.config.deviceId,
        listId,
        payload: this.encryptUpdate(stateVector, listId),
      });
    } catch (err) {
      console.warn('YjsWebSocket: failed to send state vector', err);
    }
  }

  /**
   * Flush all queued updates to the relay server.
   */
  private flushOfflineQueue(): void {
    if (this.offlineQueue.length === 0) return;

    const queue = [...this.offlineQueue];
    this.offlineQueue = [];
    const delivered: Array<string | null | undefined> = [];

    for (const entry of queue) {
      if (this.state === 'connected' && this.ws && this.config.canSendList?.(entry.listId) !== false) {
        try {
          const encrypted = this.encryptUpdate(entry.update, entry.listId);
          this.sendMessage({
            type: 'update',
            familyId: this.config.familyId,
            deviceId: this.config.deviceId,
            listId: entry.listId,
            payload: encrypted,
          });
          delivered.push(entry.persistedId);
        } catch {
          // Re-queue if send fails
          this.offlineQueue.push(entry);
        }
      } else {
        this.offlineQueue.push(entry);
      }
    }

    if (delivered.some(Boolean)) {
      this.deletePersisted(delivered);
    }

    if (this.offlineQueue.length === 0) {
      this.onQueueDrained?.();
    }
  }

  // ─── Receiving Updates ─────────────────────────────────────────────────

  private async handleMessage(data: RelayMessage): Promise<void> {
    if (this.disposed) return;
    switch (data.type) {
      case 'auth_ack': {
        // Authentication successful — clear timeout, send identity, flush queue
        this.authPending = false;
        if (this._ackTimeout) {
          clearTimeout(this._ackTimeout);
          this._ackTimeout = null;
        }
        this.setState('connected');
        this.sendMessage({
          type: 'identity',
          familyId: this.config.familyId,
          deviceId: this.config.deviceId,
        });
        this.flushOfflineQueue();
        this.onReconnected?.();
        break;
      }
      case 'sync_request': {
        // A peer told us where it is up to. The state vector is encrypted
        // under the family key with the same envelope as an update, so the
        // relay learns nothing beyond "someone reconciled this list".
        if (data.listId && data.payload) {
          // Same narrow scope as the 'update' case, for the same reason.
          let stateVector: Uint8Array;
          try {
            stateVector = this.decryptUpdate(data.payload, data.listId);
          } catch (err) {
            // Used to warn to the console only, which no user has ever read.
            this.reportDecryptFailure(data.listId, err);
            break;
          }
          this.noteDecryptOk(data.listId);
          this.onSyncRequest?.(data.listId, stateVector, data.deviceId ?? '');
        }
        break;
      }
      case 'recovery_request':
      case 'recovery_response': {
        if (!data.listId || !data.payload) break;
        let value: any;
        try { value = JSON.parse(sodium.to_string(this.decryptUpdate(data.payload, data.listId))); }
        catch (err) { this.reportDecryptFailure(data.listId, err); break; }
        if (typeof value?.requestId !== 'string' || value.listId !== data.listId || value.senderDeviceId !== data.deviceId) break;
        if (data.type === 'recovery_request' && value.kind === 'crdt-recovery-request') {
          this.onRecoveryRequest?.(data.listId, value.requestId, value.senderDeviceId);
        } else if (value.kind === 'complete-crdt-recovery' && value.targetDeviceId === this.config.deviceId && this.recoveryRequests.get(data.listId) === value.requestId) {
          if (!Array.isArray(value.update) || value.update.some((byte: unknown) => !Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255)) break;
          this.onRecoveryResponse?.(data.listId, new Uint8Array(value.update));
        }
        break;
      }
      case 'update': {
        if (data.listId && data.payload) {
          // MUST catch locally. Without this the throw unwound to the generic
          // onmessage handler, which console.warn'd it and moved on — so a
          // device whose key does not match the family's silently discarded
          // every incoming update while the UI kept saying "Synced". That is
          // the worst possible presentation of this failure: the user believes
          // they are seeing the family's lists and they are not.
          // The try covers ONLY the decrypt. An earlier version also wrapped
          // onRemoteUpdate, which routes into Y.applyUpdate and a zustand
          // setState whose subscribers run SYNCHRONOUSLY — so any throwing
          // selector or render came back through this catch and was relabelled
          // a decryption failure by construction, latching "can't read your
          // lists" on a device whose key was perfectly correct.
          let decrypted: Uint8Array;
          try {
            decrypted = this.decryptUpdate(data.payload, data.listId);
          } catch (err) {
            this.reportDecryptFailure(data.listId, err);
            break;
          }
          this.noteDecryptOk(data.listId);
          this.onRemoteUpdate?.(data.listId, decrypted);
        }
        break;
      }
      case 'ack': {
        // Server acknowledged — nothing to do
        break;
      }
      case 'notification': {
        if (data.listId && data.payload) {
          this.onNotification?.(data.listId, data.payload, data.deviceId ?? '');
        }
        break;
      }
      case 'error': {
        const message = data.message ?? 'Relay server error';
        // A relay that predates reconciliation answers sync_request from its
        // `default:` branch. That is a version skew, not a user-facing fault:
        // surfacing it would put a red sync error on screen after every
        // reconnect. Latch it so we ask once per process instead of once per
        // list per reconnect. Reconciliation simply does not happen until the
        // relay is upgraded; everything else on the connection is unaffected.
        if (/Unknown message type:\s*(sync_request|recovery_request|recovery_response)/i.test(message)) {
          if (!this.reconciliationUnsupported) {
            this.reconciliationUnsupported = true;
            console.warn('YjsWebSocket: relay does not support reconciliation yet — disabled');
          }
          break;
        }
        this.onError?.(new Error(message));
        break;
      }
      default:
        console.warn('YjsWebSocket: unknown message type', (data as any).type);
    }
  }

  // ─── Encryption / Decryption of Yjs Updates ───────────────────────────
  // Uses listId as AAD (Additional Authenticated Data) to bind each
  // ciphertext to its specific list context, preventing cross-list replay.

  /**
   * Encrypt a raw Yjs update (Uint8Array) using crypto/index.ts (XChaCha20-Poly1305).
   * Uses listId as AAD to bind ciphertext to a specific list context.
   */
  private encryptUpdate(update: Uint8Array, listId: string): EncryptedData {
    // Convert Uint8Array to base64 string for the encrypt function
    const updateB64 = sodium.to_base64(update, sodium.base64_variants.ORIGINAL);
    // We keep it simple by using the underlying sodium directly to avoid
    // making sendUpdate async throughout the codebase.
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    // Use listId as AAD to bind ciphertext to a specific list
    // The native binding accepts string AAD; libsodium encodes it as UTF-8.
    const additionalData = listId;
    const cipherWithTag = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      update,
      additionalData,
      null,
      nonce,
      this.encryptKey,
    );
    const ciphertext = cipherWithTag.slice(0, cipherWithTag.length - ABYTES);
    const tag = cipherWithTag.slice(cipherWithTag.length - ABYTES);

    return {
      ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
      iv: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
      tag: sodium.to_base64(tag, sodium.base64_variants.ORIGINAL),
    };
  }

  /**
   * Decrypt an encrypted Yjs update using the listId as AAD.
   * The listId must match what was used during encryption.
   */
  /**
   * Report a ciphertext that failed authentication, at most once per list.
   *
   * Throttled per list because the relay replays its entire retained history
   * on connect — up to 30 days of updates. A device with the wrong key fails
   * on every single one, so reporting per message would mean thousands of
   * identical console lines and store writes on each reconnect, which is its
   * own outage. One report per list is enough to change what the UI says, and
   * the count still accumulates for anyone reading it.
   */
  private reportDecryptFailure(listId: string, cause: unknown): void {
    if (this.reportedDecryptFailures.has(listId)) return;
    this.reportedDecryptFailures.add(listId);
    const err = new DecryptFailureError(listId, cause);
    console.warn('[sync]', err.message, cause);
    // onError reaches a zustand set, whose subscribers run synchronously, so a
    // bad render can throw from here. That must not escape into the socket's
    // message handler — the generic catch there is the swallow this whole
    // change exists to remove, and re-entering it would be circular.
    try {
      this.onError?.(err);
    } catch (reportErr) {
      console.warn('[sync] decrypt-failure listener threw', reportErr);
    }
  }

  /**
   * A list decrypted cleanly. If it had been reported as unreadable, say so —
   * otherwise a device that is fixed by a correct recovery goes on telling the
   * user it cannot read their lists, with force-quitting the app as the only
   * way to clear it. Reporting a problem you never retract is its own defect.
   */
  private noteDecryptOk(listId: string): void {
    if (!this.reportedDecryptFailures.delete(listId)) return;
    try {
      this.onDecryptRecovered?.(listId);
    } catch (err) {
      console.warn('[sync] decrypt-recovery listener threw', err);
    }
  }

  private decryptUpdate(data: EncryptedData, listId: string): Uint8Array {
    const nonce = sodium.from_base64(data.iv, sodium.base64_variants.ORIGINAL);
    const tag = sodium.from_base64(data.tag, sodium.base64_variants.ORIGINAL);
    const ciphertext = sodium.from_base64(data.ciphertext, sodium.base64_variants.ORIGINAL);

    const cipherWithTag = new Uint8Array(ciphertext.length + tag.length);
    cipherWithTag.set(ciphertext);
    cipherWithTag.set(tag, ciphertext.length);

    const additionalData = listId;

    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      cipherWithTag,
      additionalData,
      nonce,
      this.encryptKey,
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Enqueue an update for later delivery, dropping oldest entry if queue is full.
   * When dropping, logs a warning and calls onError callback.
   */
  private enqueueOffline(update: Uint8Array, listId: string): void {
    if (this.offlineQueue.length >= MAX_QUEUE_SIZE) {
      const dropped = this.offlineQueue.shift(); // drop oldest
      if (dropped) {
        dropped.dropped = true; // in case its disk write has not landed yet
        if (dropped.persistedId) this.deletePersisted([dropped.persistedId]);
      }
      this.onError?.(new Error(
        `Offline queue full (${MAX_QUEUE_SIZE}). Dropped oldest update for list ${dropped?.listId ?? 'unknown'}.`,
      ));
      console.warn(
        `YjsWebSocket: offline queue full. Dropped ${dropped ? 1 : 0} oldest entry(s). ` +
        `Queue now has ${this.offlineQueue.length} pending entries.`,
      );
    }
    const entry: OfflineEntry = { update, listId, timestamp: Date.now(), persistedId: null };
    this.offlineQueue.push(entry);
    this.persistEntry(entry);
  }

  /**
   * Disk persistence of a queued entry (encrypted wire envelope). The
   * in-memory queue keeps working even if this fails, but the failure is not
   * cosmetic — an entry that never reaches disk is lost if the app is killed
   * before it is delivered, which is the exact scenario the queue exists for.
   * So it is reported rather than swallowed.
   */
  private persistEntry(entry: OfflineEntry): void {
    if (!this.ready) {
      this.reportPersistFailure(entry.listId, new Error('libsodium not ready'));
      return; // cannot encrypt for disk yet
    }
    try {
      const encrypted = this.encryptUpdate(entry.update, entry.listId);
      const saving = import('./offline-queue-store')
        .then(({ saveQueueEntry }) => saveQueueEntry(entry.listId, encrypted, entry.timestamp))
        .then((id) => {
          // Evicted while the write was in flight — delete rather than track,
          // or the row outlives the queue that is supposed to own it.
          if (entry.dropped) {
            if (id) this.deletePersisted([id]);
            return;
          }
          entry.persistedId = id;
          // saveQueueEntry returns null on a failed write rather than throwing.
          if (!id) this.reportPersistFailure(entry.listId, new Error('write returned no row id'));
        })
        .catch((err) => this.reportPersistFailure(entry.listId, err));
      this.trackStorage(saving);
    } catch (err) {
      this.reportPersistFailure(entry.listId, err);
    }
  }

  private reportPersistFailure(listId: string, err: unknown): void {
    console.warn(`YjsWebSocket: failed to persist queued update for list ${listId}`, err);
    this.onError?.(new Error(
      `A pending change for list ${listId} could not be saved to disk and will be ` +
      `lost if the app closes before it syncs.`,
    ));
  }

  /** Best-effort removal of delivered/dropped entries from disk. */
  private deletePersisted(ids: Array<string | null | undefined>): void {
    this.trackStorage(import('./offline-queue-store')
      .then(({ deleteQueueEntries }) => deleteQueueEntries(ids))
      .catch(() => {}));
  }

  private trackStorage(operation: Promise<unknown>): void {
    this.storageOperations.add(operation);
    operation.then(() => this.storageOperations.delete(operation), () => this.storageOperations.delete(operation));
  }

  /** One authenticated complete peer snapshot, correlated to this session. */
  requestRecovery(listId: string): void {
    if (!this.ready || this.disposed || this.state !== 'connected') return;
    const requestId = sodium.to_base64(sodium.randombytes_buf(16), sodium.base64_variants.ORIGINAL);
    this.recoveryRequests.set(listId, requestId);
    this.sendMessage({ type: 'recovery_request', familyId: this.config.familyId, deviceId: this.config.deviceId, listId,
      payload: this.encryptUpdate(encodeRecoveryMessage({ kind: 'crdt-recovery-request', listId, requestId, senderDeviceId: this.config.deviceId }), listId), });
  }

  sendRecoveryState(listId: string, requestId: string, targetDeviceId: string, update: Uint8Array): void {
    if (!this.ready || this.disposed || this.state !== 'connected') return;
    this.sendMessage({ type: 'recovery_response', familyId: this.config.familyId, deviceId: this.config.deviceId, listId,
      payload: this.encryptUpdate(encodeRecoveryMessage({ kind: 'complete-crdt-recovery', listId, requestId, senderDeviceId: this.config.deviceId, targetDeviceId, update: Array.from(update) }), listId), });
  }

  private sendMessage(msg: RelayMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Get the current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get the number of pending offline updates.
   */
  getPendingCount(): number {
    return this.offlineQueue.length + this.heldCount;
  }
}

// ─── Relay Message Types ─────────────────────────────────────────────────────

interface RelayMessage {
  type: 'auth' | 'auth_ack' | 'identity' | 'update' | 'ack' | 'error' | 'notification' | 'sync_request' | 'recovery_request' | 'recovery_response';
  familyId?: string;
  deviceId?: string;
  listId?: string;
  payload?: EncryptedData;
  message?: string;
  relayToken?: string;
}
