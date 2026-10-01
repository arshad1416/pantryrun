/**
 * Data Wipe — the in-app "Delete All Data" path (store-required deletion).
 *
 * Both stores require a user-accessible data-deletion mechanism even though
 * PantryRun has no accounts. This wipes everything the app persists on the
 * device:
 *
 *   1. Sync connection (disconnected first so nothing re-persists mid-wipe)
 *   2. Every in-memory Yjs document (destroyAllDocs)
 *   3. The WatermelonDB database (unsafeResetDatabase inside a writer block)
 *   4. Every groceryapp.* secure-store entry the device can address:
 *        groceryapp.master_key                     (crypto/index.ts)
 *        groceryapp.relay_token, groceryapp.relay_url  (identity/enroll.ts;
 *          pricing/tokens.ts reads the same relay_token key)
 *        groceryapp.settings.cache, groceryapp.device.settings_key (settings.ts)
 *        groceryapp.family.membership              (identity/family.ts)
 *        groceryapp.passkey.supported and the current device's
 *        groceryapp.passkey.credential.<deviceId>  (identity/passkeys.ts)
 *        groceryapp.recovery.{seed,phrase,stored}.<currentFamilyId>
 *                                                  (identity/recovery.ts)
 *        groceryapp.device.{secret_key,public_key,id}  (identity/device.ts)
 *   5. In-memory zustand stores (lists, items, family, prices, sync state)
 *
 * HONEST LIMITATION (mirrored in the privacy policy): expo-secure-store has
 * no key-enumeration API, so recovery/passkey entries prefixed with a family
 * or device id this install has forgotten cannot be addressed by name and may
 * survive. The wipe attempts to delete the master key and device keypair,
 * but a failed stage may leave keys behind. Forgotten recovery/passkey entries
 * may also remain usable. Other family devices, recovery phrase holders, and
 * relay copies are unaffected; local deletion cannot guarantee those copies
 * become unreadable.
 *
 * The wipe is deliberately best-effort per stage: a failure in one stage is
 * recorded when a helper propagates its error, and the remaining stages still
 * run. Some cleanup helpers swallow errors, so completion does not guarantee
 * that every addressable key was erased.
 */

import { syncManager } from '../sync/sync-manager';
import { destroyAllDocs } from '../sync/yjs-adapter';
import { getDatabase } from '../storage/database';
import { clearMasterKey } from '../crypto';
import { clearRecoveryPhrase } from '../identity/recovery';
import { clearFamilyMembership } from '../identity/family';
import { clearDeviceIdentity } from '../identity/device';
import { clearRelayCredentials } from '../identity/enroll';
import { clearPasskeyData } from '../identity/passkeys';
import { clearSettings } from '../config/settings';

export interface WipeResult {
  /** Stages that completed. */
  completed: string[];
  /** Stage name → error message for anything that failed. */
  errors: Record<string, string>;
}

async function runStage(
  name: string,
  fn: () => Promise<void> | void,
  result: WipeResult,
): Promise<void> {
  try {
    await fn();
    result.completed.push(name);
  } catch (err) {
    result.errors[name] = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Delete all local PantryRun data. Irreversible without the recovery phrase.
 * Returns a per-stage report; callers should surface any errors to the user.
 */
export async function deleteAllLocalData(): Promise<WipeResult> {
  const result: WipeResult = { completed: [], errors: {} };

  // 1. Stop syncing so nothing re-persists while we wipe.
  await runStage('disconnect-sync', () => {
    syncManager.disconnect();
  }, result);

  // 2. Attempt known-key cleanup before clearing the identities used to locate it.
  //    clearRecoveryPhrase() and clearPasskeyData() must run BEFORE membership
  //    and device identity are cleared: they resolve their prefixed key names
  //    from the current familyId / deviceId.
  await runStage('recovery-phrase', () => clearRecoveryPhrase(), result);
  await runStage('passkeys', () => clearPasskeyData(), result);
  await runStage('master-key', () => clearMasterKey(), result);
  await runStage('family-membership', () => clearFamilyMembership(), result);
  await runStage('relay-credentials', () => clearRelayCredentials(), result);
  await runStage('settings', () => clearSettings(), result);
  await runStage('device-identity', () => clearDeviceIdentity(), result);

  // 3. In-memory Yjs documents.
  await runStage('yjs-docs', () => {
    destroyAllDocs();
  }, result);

  // 4. The WatermelonDB database.
  await runStage('database', async () => {
    const db = getDatabase();
    await db.write(async () => {
      await (db as any).unsafeResetDatabase();
    });
  }, result);

  // 5. In-memory zustand stores (dynamic imports — several stores statically
  //    import syncManager, and a static back-import here would cycle).
  await runStage('memory-stores', async () => {
    const [{ useListStore }, { useGroceryStore }, { useFamilyStore }, { useSyncStore }, { usePriceStore }] =
      await Promise.all([
        import('../state/useListStore'),
        import('../state/useGroceryStore'),
        import('../state/useFamilyStore'),
        import('../state/useSyncStore'),
        import('../pricing/price-store'),
      ]);
    useListStore.setState({ lists: {} } as any);
    useGroceryStore.setState({ items: {} } as any);
    useFamilyStore.setState({ members: {} } as any);
    useSyncStore.setState({ syncState: 'not_configured', error: null } as any);
    usePriceStore.getState().clearPrices();
    usePriceStore.getState().clearPerStorePrices();
  }, result);

  return result;
}
