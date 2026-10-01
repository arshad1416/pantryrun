/**
 * Zustand store: Sync Status.
 *
 * Tracks the current synchronization state — connected, syncing, offline, etc.
 * In Phase 2, this connects to the actual Yjs WebSocket relay.
 */

import { create } from 'zustand';
import type { SyncState } from '../types';
import type { ConnectionState } from '../sync/y-websocket';
import { syncManager } from '../sync/sync-manager';
import { DecryptFailureError } from '../crypto';

// ─── State Shape ────────────────────────────────────────────────────────────

export interface SyncStateShape {
  syncState: SyncState;
  connectionState: ConnectionState;
  lastSyncedAt: number | null;
  pendingUploads: number;
  pendingDownloads: number;
  error: string | null;
  persistenceError: string | null;
  storageRecoveryError: string | null;

  /**
   * How many ciphertexts have failed authentication this session, and where
   * the last one was.
   *
   * Deliberately NOT folded into `syncState`: setConnectionState derives
   * syncState from the socket on every transition, so an error written there
   * is erased by the next successful connect. A key mismatch is not cured by
   * reconnecting — it is the one sync problem that gets *worse* the longer it
   * goes unnoticed, because the device keeps encrypting local edits under the
   * wrong key and pushing them to the family's stream. So it is sticky, and
   * only an explicit clear removes it.
   */
  undecryptableLists: readonly string[];
  /** Preserved value-only/corrupt lists waiting for original CRDT recovery. */
  recoveryPendingLists: readonly string[];

  // Actions
  setSyncState: (state: SyncState) => void;
  setConnectionState: (state: ConnectionState) => void;
  triggerSync: () => Promise<void>;
  markSynced: () => void;
  clearError: () => void;
  reportSyncError: (err: Error) => void;
  noteDecryptFailure: (listId: string) => void;
  noteDecryptOk: (listId: string) => void;
  refreshPendingCount: () => void;
}

// ─── Derived presentation ───────────────────────────────────────────────────
//
// Lives here rather than in SyncIndicator.tsx because jest's
// moduleFileExtensions is [ts, js, json] — no test can import a .tsx, so a
// label defined in the component is a label nothing can assert on. That is
// precisely how "the store field changed" became the only testable claim
// while the indicator went on reading "Synced".

/**
 * What the indicator says, as a pure function of store state.
 *
 * Extracted from the component so it can be tested. This suite has no RN
 * renderer, and a test that only asserts "the store field changed" is exactly
 * the test that passes today while the indicator still reads "Synced" — which
 * is the bug. Assert against this instead.
 */
export function syncIndicatorStatus(s: {
  syncState: SyncState;
  error: string | null;
  undecryptableLists: readonly string[];
  recoveryPendingLists?: readonly string[];
  persistenceError?: string | null;
  storageRecoveryError?: string | null;
}): { label: string; color: string } {
  // Checked FIRST, ahead of syncState. A device whose key does not match the
  // family's data is connected, online, and reporting 'idle' — every signal
  // the socket has says everything is fine, and none of them is about whether
  // the data can be read. Deferring to syncState here would render "Synced"
  // over a device that is discarding every message it receives.
  if (s.undecryptableLists.length > 0) {
    return { label: "Can't read family lists", color: '#f44336' };
  }

  if (s.persistenceError) return { label: s.persistenceError, color: '#f44336' };
  if (s.storageRecoveryError) return { label: s.storageRecoveryError, color: '#f44336' };
  if (s.recoveryPendingLists?.length) return { label: 'List recovery needed — sharing paused', color: '#f44336' };

  if (s.syncState === 'syncing') return { label: 'Syncing...', color: '#FF9800' };
  // In the error state, prefer the specific message set by whoever reported
  // it (e.g. "Couldn't save recent changes to this device" for a failed local
  // write) — a blanket "Sync error" misleads when the failure isn't sync.
  if (s.syncState === 'error') return { label: s.error || 'Sync error', color: '#f44336' };
  if (s.syncState === 'offline') return { label: 'Offline', color: '#999' };
  if (s.syncState === 'not_configured') return { label: 'Local only', color: '#999' };
  // An authenticated socket is not proof that another device applied our edits.
  return { label: 'Connected', color: '#10B981' };
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useSyncStore = create<SyncStateShape>((set, get) => ({
  // Start as not_configured: a fresh device has no relay/family, so it must not
  // display "Synced". bootstrapSync() promotes this once a relay connects.
  syncState: 'not_configured',
  connectionState: 'disconnected',
  lastSyncedAt: null,
  pendingUploads: 0,
  pendingDownloads: 0,
  error: null,
  persistenceError: null,
  storageRecoveryError: null,
  undecryptableLists: [],
  recoveryPendingLists: [],

  setSyncState: (syncState) => {
    // Going local-only retracts the warning. bootstrapSync sets this when the
    // device has no relay, family or key, which is exactly the state a user
    // reaches by LEAVING a family — at which point "can't read family lists"
    // is stale, and worse, it would suppress the tappable "tap to set up
    // sharing" row on Home and leave a dead one in its place.
    if (syncState === 'not_configured') {
      set({ syncState, undecryptableLists: [] });
      return;
    }
    set({ syncState });
  },

  setConnectionState: (connectionState) => {
    const syncState = connectionState === 'connected' ? 'idle' :
      connectionState === 'connecting' ? 'syncing' :
      connectionState === 'error' ? 'error' : 'offline';
    set({ connectionState, syncState });
  },

  triggerSync: async () => {
    set({ syncState: 'syncing', error: null });
    try {
      // If the sync manager is ready and connected, flush any pending offline queue
      const client = syncManager.getClient();
      if (client) {
        const pending = client.getPendingCount();
        set({ pendingUploads: pending });

        // Wait a brief moment for queued messages to flush
        await new Promise((resolve) => setTimeout(resolve, 500));

        const remaining = client.getPendingCount();
        set({
          syncState: remaining > 0 ? 'syncing' : 'idle',
          lastSyncedAt: Date.now(),
          pendingUploads: remaining,
          pendingDownloads: 0,
        });
      } else {
        set({
          syncState: 'idle',
          lastSyncedAt: Date.now(),
          pendingUploads: 0,
          pendingDownloads: 0,
        });
      }
    } catch (err) {
      set({
        syncState: 'error',
        error: err instanceof Error ? err.message : 'Sync failed',
      });
    }
  },

  markSynced: () => {
    set({
      syncState: 'idle',
      lastSyncedAt: Date.now(),
      pendingUploads: 0,
      pendingDownloads: 0,
    });
  },

  refreshPendingCount: () => {
    const client = syncManager.getClient();
    if (client) {
      const pending = client.getPendingCount();
      set({ pendingUploads: pending });
    }
  },

  clearError: () => {
    set({ error: null, persistenceError: null });
  },

  /**
   * The single entry point for a sync-layer error, so the routing decision is
   * testable rather than buried in a bootstrap callback.
   *
   * It lives here because the previous version of that callback wrote `error`
   * and nothing else — and the indicator only consults `error` in the error
   * state — so every sync error was recorded somewhere nothing displayed. A
   * branch that decides what the user sees belongs next to the state it sets.
   */
  reportSyncError: (err) => {
    if (err instanceof DecryptFailureError) {
      // Sticky: no reconnect fixes a key mismatch, and a wrong-key device
      // connects perfectly, so leaving this to syncState would erase it.
      get().noteDecryptFailure(err.context);
      return;
    }
    set({ error: err.message, syncState: 'error' });
  },

  noteDecryptFailure: (listId) => {
    set((s) =>
      s.undecryptableLists.includes(listId)
        ? s
        : { undecryptableLists: [...s.undecryptableLists, listId] },
    );
  },

  /**
   * Retract a list: it decrypts again.
   *
   * This is what makes the warning survivable. An earlier version counted
   * failures and exposed a clearDecryptFailures() that NOTHING called, so a
   * user who successfully fixed their key kept being told the app could not
   * read their lists, with force-quitting as the only way out. A warning you
   * never retract is its own defect.
   *
   * Returns the same object when nothing changed, so subscribers do not
   * re-render on every successful message.
   */
  noteDecryptOk: (listId) => {
    set((s) =>
      s.undecryptableLists.includes(listId)
        ? { undecryptableLists: s.undecryptableLists.filter((l) => l !== listId) }
        : s,
    );
  },
}));