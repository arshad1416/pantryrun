/**
 * Sync bootstrap — the missing link between app startup and the sync stack.
 *
 * Before this existed, `syncManager.init()` / `hydrateFromDB()` were never
 * called from runtime code: lists lived only in in-memory Yjs docs (gone on
 * restart) and the relay WebSocket never connected. All the machinery was
 * built and tested; nothing invoked it.
 *
 * Called once from App.tsx after crypto, database, identity, and settings
 * are initialised. Every step after key provisioning is best-effort: no
 * family peer and no relay is a normal state, not an error.
 */

import { syncManager } from './sync-manager';
import type { ConnectionState } from './y-websocket';

/**
 * Establish the identity and key material a first launch needs.
 *
 * Nothing can be stored before this runs: `persistListToDB` now rejects
 * without an encryption key (it used to return silently, which is how a
 * missing key lost every write without a signal), and the recovery system is
 * keyed by familyId.
 * The key is minted through the recovery-phrase path so it is backed up from
 * birth — provisioning a bare random key would leave the user permanently
 * unable to generate a recovery phrase (`generateRecoveryPhrase` refuses to
 * run once a master key exists) and their data unrecoverable.
 *
 * @returns The provisioned master key, or null if provisioning failed.
 */
async function provisionFirstRun(): Promise<Uint8Array | null> {
  try {
    const { getMasterKey, setMasterKeyType } = await import('../crypto');
    const { ensureFamilyMembership } = await import('../identity/family');
    const { getDeviceKeypair } = await import('../identity/device');
    const { generateRecoveryPhrase } = await import('../identity/recovery');

    await ensureFamilyMembership(getDeviceKeypair());
    await generateRecoveryPhrase();
    // The recovery path tags its key 'recovery'. This one belongs to a family
    // of one, so mark it as such — the join flow must not mistake it for the
    // key of a family this device has actually been let into.
    await setMasterKeyType('device');

    return await getMasterKey();
  } catch (err) {
    console.warn('[bootstrap] First-run provisioning failed:', err);
    return null;
  }
}

/**
 * Hydrate Yjs docs from WatermelonDB and, when enrolled with a relay,
 * connect the sync WebSocket.
 *
 * @returns 'no-key' | 'local-only' | 'connected' — for logging/tests.
 */
export async function bootstrapSync(): Promise<'no-key' | 'local-only' | 'connected' | 'cancelled'> {
  const beforeHydration = syncManager.getSessionGeneration();
  const { getMasterKey } = await import('../crypto');
  const { useSyncStore } = await import('../state/useSyncStore');
  let masterKey = await getMasterKey();
  if (!masterKey) {
    // First launch — mint identity and keys before anything is stored.
    masterKey = await provisionFirstRun();
  }
  if (!masterKey) {
    // Provisioning failed; stay local rather than crash, but persistence is
    // disabled until a key exists.
    useSyncStore.getState().setSyncState('not_configured');
    return 'no-key';
  }

  // 1. Restore persisted lists/items into Yjs so the UI sees them.
  if (syncManager.getSessionGeneration() !== beforeHydration) return 'cancelled';
  await syncManager.hydrateFromDB(masterKey);
  const session = beforeHydration + 1;
  if (syncManager.getSessionGeneration() !== session) return 'cancelled';

  // 2. Connect the relay if this device is enrolled in a family.
  const { getRelayToken, getRelayUrl } = await import('../identity/enroll');
  const { getFamilyId } = await import('../identity/family');
  const { getDeviceId } = await import('../identity/device');
  const { getSettings } = await import('../config/settings');

  const [relayToken, storedRelayUrl, familyId] = await Promise.all([
    getRelayToken(),
    getRelayUrl(),
    getFamilyId(),
  ]);
  if (syncManager.getSessionGeneration() !== session) return 'cancelled';
  const deviceId = getDeviceId();

  const settings = getSettings();
  const baseUrl = storedRelayUrl || settings.relayUrl;

  if (!relayToken || !baseUrl || !familyId || !deviceId) {
    // Not enrolled (or relay not configured) — local-only mode. The Yjs
    // observer still persists edits to WatermelonDB via the key set above.
    useSyncStore.getState().setSyncState('not_configured');
    return 'local-only';
  }

  // Ensure a ws:// or wss:// URL. Use URL parsing so a default port is only
  // added for plain ws:// hosts without one — appending ":8080" to an https
  // relay (implicit 443) or after a path would produce a broken URL.
  let wsUrl = baseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  try {
    const parsed = new URL(wsUrl);
    if (!parsed.port && parsed.protocol === 'ws:') {
      parsed.port = String(settings.relayPort || 8080);
    }
    wsUrl = parsed.toString().replace(/\/$/, '');
  } catch {
    // Unparseable — fall back to the legacy suffix behavior for bare hosts
    const hasPort = /:\d+/.test(wsUrl.replace(/^wss?:\/\//, ''));
    if (!hasPort) {
      wsUrl = `${wsUrl}:${settings.relayPort || 8080}`;
    }
  }

  const { useGroceryStore } = await import('../state/useGroceryStore');
  const { useListStore } = await import('../state/useListStore');

  await syncManager.init(
    {
      url: wsUrl,
      familyId,
      deviceId,
      encryptionKey: masterKey,
      relayToken,
    },
    {
      onConnectionChange: (state: ConnectionState) => {
        useSyncStore.getState().setConnectionState(state);
      },
      // Routing lives in the store (reportSyncError) so it can be tested. This
      // callback previously did `setState({ error: err.message })`, which the
      // indicator never rendered — it only consults `error` when syncState is
      // 'error'. Every sync error went into a field nothing displayed.
      onSyncError: (err: Error) => {
        useSyncStore.getState().reportSyncError(err);
      },
      onDecryptRecovered: (listId: string) => {
        useSyncStore.getState().noteDecryptOk(listId);
      },
      onRemoteItemsUpdate: (listId, items) => {
        // Refresh discovery and metadata as well as an already-open list.
        useListStore.getState().loadLists().catch(() => {});
        // Refresh the visible list when a family member's update arrives.
        const grocery = useGroceryStore.getState();
        if (grocery.activeListId === listId) {
          const itemsMap: Record<string, (typeof items)[number]> = {};
          for (const item of items) itemsMap[item.id] = item;
          useGroceryStore.setState({ items: itemsMap });
        }
      },
    },
    session,
  );

  return syncManager.getSessionGeneration() === session ? 'connected' : 'cancelled';
}
