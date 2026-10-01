/**
 * Zustand store: Grocery Lists.
 *
 * Uses Yjs as the source of truth for real-time sync. WatermelonDB persistence
 * is handled by SyncManager observing Yjs changes.
 *
 * All mutations go through Yjs shared types which handle CRDT merging
 * across family members automatically.
 */

import { create } from 'zustand';
import type { GroceryList, SyncStatus } from '../types';
import { generateUUID } from '../crypto';
import {
  getDoc,
  extractList,
  yjsUpdateListMeta,
} from '../sync/yjs-adapter';
import { syncManager } from '../sync/sync-manager';

// ─── State Shape ────────────────────────────────────────────────────────────

export interface ListState {
  lists: Record<string, GroceryList>;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadLists: () => Promise<void>;
  createList: (name: string, familyId: string, description?: string) => Promise<GroceryList>;
  updateList: (id: string, changes: Partial<GroceryList>) => Promise<void>;
  deleteList: (id: string) => Promise<void>;
  /** Restore a soft-deleted list (used by undo after delete) */
  restoreList: (list: GroceryList) => Promise<void>;
  clearError: () => void;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useListStore = create<ListState>((set, get) => ({
  lists: {},
  isLoading: false,
  error: null,

  loadLists: async () => {
    set({ isLoading: true, error: null });
    try {
      // Extract lists from Yjs documents (hydrated from WatermelonDB on app start)
      const docIds = ['__family__']; // There's no global registry of lists — Yjs docs are keyed by listId
      // For now, we read from Yjs docs that are already registered
      // This will be populated by hydration in the sync manager
      const listsMap: Record<string, GroceryList> = {};

      // We'll iterate known doc IDs from the sync manager's perspective
      // For now, keep the existing pattern but read from Yjs when available
      const doc = getDoc('__lists_index__');
      const indexMap = doc.getMap('listIds');
      const listIds: string[] = [];
      indexMap.forEach((_value: any, key: string) => {
        listIds.push(key);
      });

      for (const listId of listIds) {
        const list = extractList(listId);
        if (list) {
          listsMap[list.id] = list;
        }
      }

      set({ lists: listsMap, isLoading: false });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load lists',
      });
    }
  },

  createList: async (name, familyId, description?) => {
    const now = Date.now();
    const id = await generateUUID();
    const newList: GroceryList = {
      id,
      familyId,
      name,
      description,
      isActive: true,
      isDeleted: false,
      deletedAt: null,
      version: 1,
      syncStatus: 'created',
      createdAt: now,
      updatedAt: now,
    };

    // Observe before the first transaction so empty lists are published and saved.
    syncManager.registerList(id);
    const doc = getDoc(id);
    doc.transact(() => {
      const meta = doc.getMap('meta');
      meta.set('id', newList.id);
      meta.set('familyId', newList.familyId);
      meta.set('name', newList.name);
      meta.set('description', newList.description ?? '');
      meta.set('storePreference', '');
      meta.set('isActive', newList.isActive);
      meta.set('isDeleted', newList.isDeleted);
      meta.set('deletedAt', newList.deletedAt);
      meta.set('version', newList.version);
      meta.set('syncStatus', newList.syncStatus);
      meta.set('createdAt', newList.createdAt);
      meta.set('updatedAt', newList.updatedAt);
    });

    // Register in the lists index
    const indexDoc = getDoc('__lists_index__');
    indexDoc.transact(() => {
      const indexMap = indexDoc.getMap('listIds');
      indexMap.set(id, true);
    });

    set((state) => ({
      lists: { ...state.lists, [newList.id]: newList },
    }));

    return newList;
  },

  updateList: async (id, changes) => {
    const existing = get().lists[id];
    if (!existing) return;

    // Protect createdAt from being overwritten
    const { createdAt: _, ...safeChanges } = changes;

    // Mutate through Yjs
    yjsUpdateListMeta(id, safeChanges);

    set((state) => ({
      lists: {
        ...state.lists,
        [id]: {
          ...existing,
          ...safeChanges,
          version: existing.version + 1,
          syncStatus: 'updated' as SyncStatus,
          updatedAt: Date.now(),
        },
      },
    }));
  },

  deleteList: async (id) => {
    const existing = get().lists[id];
    if (!existing) return;

    // 1. Soft-delete via Yjs
    yjsUpdateListMeta(id, {
      isDeleted: true,
      deletedAt: Date.now(),
      isActive: false,
      syncStatus: 'deleted',
    });

    // 2. Remove from lists index
    const indexDoc = getDoc('__lists_index__');
    indexDoc.transact(() => {
      const indexMap = indexDoc.getMap('listIds');
      indexMap.delete(id);
    });

    // 3. Unregister from sync
    syncManager.unregisterList(id);

    // 4. Send family notification
    try {
      const { sendFamilyNotification } = await import('../notifications/NotificationManager');
      const encryptionKey = syncManager.getEncryptionKey();
      if (encryptionKey) {
        await sendFamilyNotification(
          'list_deleted',
          id,
          existing.name,
          id,              // listId as "itemId" for list-level events
          existing.name,   // list name as "itemName"
          'list',          // category
          encryptionKey,
        );
      }
    } catch {
      // Notifications are best-effort — non-critical
    }

    // 5. Update local state
    set((state) => {
      const { [id]: _, ...remaining } = state.lists;
      return { lists: remaining };
    });
  },

  restoreList: async (list) => {
    const restored: GroceryList = {
      ...list,
      isDeleted: false,
      deletedAt: null,
      isActive: true,
      syncStatus: 'updated',
      updatedAt: Date.now(),
    };

    // 1. Un-delete via Yjs
    yjsUpdateListMeta(list.id, {
      isDeleted: false,
      deletedAt: null,
      isActive: true,
      syncStatus: 'updated',
    });

    // 2. Re-register in the lists index
    const indexDoc = getDoc('__lists_index__');
    indexDoc.transact(() => {
      const indexMap = indexDoc.getMap('listIds');
      indexMap.set(list.id, true);
    });

    // 3. Re-register for sync
    syncManager.registerList(list.id);

    // 4. Re-add to local state
    set((state) => ({
      lists: { ...state.lists, [list.id]: restored },
    }));
  },

  clearError: () => {
    set({ error: null });
  },
}));