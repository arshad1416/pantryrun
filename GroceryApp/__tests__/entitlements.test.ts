/**
 * PantryRun Plus entitlement — persistence and resolution tests.
 *
 * Runtime tests against the entitlement module (src/config/entitlements.ts,
 * the ONLY file that computes entitlement state), using the writer-strict
 * WatermelonDB mock:
 *  1. Fresh install: no local record → resolveEntitlement() → not entitled,
 *     so StopOptimizer's `{TRIP_OPTIMIZER_ENABLED && isPlus && (` guard
 *     cannot render.
 *  2. Purchase-shaped grant persisted → simulated relaunch (store reset,
 *     resolve again from the table) → entitled. This is the restart-survival
 *     property the local `entitlements` table exists for (Yjs doc state is
 *     never persisted).
 *  3. A second family device: an entitlement record arriving through the
 *     family Yjs document's `entitlements` map is picked up by the observer,
 *     persisted locally, and resolves entitled.
 *  4. Expired records do not entitle.
 *
 * The purchase/restore store flows themselves need real store accounts and
 * products (owner-only prerequisites) — they are exercised on-device, not
 * here. react-native-iap is lazily imported by those paths only, so this
 * suite never touches the native module.
 *
 * Run: npx jest __tests__/entitlements.test.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  useEntitlementStore,
  resolveEntitlement,
  isPlusEntitled,
  PLUS_PRODUCT_ID,
  EXPIRY_GRACE_MS,
} from '../src/config/entitlements';
import { getDoc } from '../src/sync/yjs-adapter';
import { getDatabase } from '../src/storage/database';

// The watermelondb mock (jest moduleNameMapper) exposes _resetDB; the real
// package types don't, hence the require + any.
const { _resetDB } = require('@nozbe/watermelondb') as any;

// ─── Helpers ────────────────────────────────────────────────────────────────

function resetEntitlementState(): void {
  useEntitlementStore.setState({
    isPlus: false,
    record: null,
    resolution: 'unresolved',
    busy: false,
    lastError: null,
  });
}

async function persistGrantDirectly(overrides: Record<string, unknown> = {}): Promise<void> {
  // Write a purchase-shaped row the way the grant path does: single flat
  // database.write() (the mock, like real WatermelonDB, throws outside a
  // writer; real WatermelonDB also deadlocks on nested write()).
  const collection = getDatabase().get('entitlements');
  await getDatabase().write(async () => {
    await collection.create((row: any) => {
      row.familyId = 'fam-1';
      row.productId = PLUS_PRODUCT_ID;
      row.platform = 'ios';
      row.transactionId = 'tx-test-1';
      row.purchasedAt = Date.now();
      row.expiresAt = null;
      row.source = 'purchase';
      row.updatedAt = Date.now();
      Object.assign(row, overrides);
    });
  });
}

beforeEach(() => {
  _resetDB();
  resetEntitlementState();
});

// ─── 1. Fresh install ────────────────────────────────────────────────────────

describe('fresh install (no purchase)', () => {
  it('resolves not entitled, so the StopOptimizer guard cannot render', async () => {
    const entitled = await resolveEntitlement();
    expect(entitled).toBe(false);
    expect(isPlusEntitled()).toBe(false);
    const state = useEntitlementStore.getState();
    expect(state.resolution).toBe('resolved');
    expect(state.record).toBeNull();
    // The render gate in GroceryListScreen is
    // {TRIP_OPTIMIZER_ENABLED && isPlus && ( <StopOptimizer … /> )}
    // — with isPlus false the JSX guard short-circuits and StopOptimizer
    // does not render. (free-tier-posture.test.ts pins that this is the
    // only render site and the exact guard shape.)
    const TRIP_OPTIMIZER_ENABLED = true;
    const rendersStopOptimizer = Boolean(TRIP_OPTIMIZER_ENABLED && state.isPlus);
    expect(rendersStopOptimizer).toBe(false);
  });
});

// ─── 2. Purchase then relaunch ───────────────────────────────────────────────

describe('purchase then relaunch (restart survival)', () => {
  it('a persisted grant survives a simulated app restart', async () => {
    await persistGrantDirectly();

    // Simulated relaunch: in-memory state is wiped (the zustand store is
    // rebuilt from scratch on a real launch); ONLY the table survives.
    resetEntitlementState();
    expect(isPlusEntitled()).toBe(false);

    const entitled = await resolveEntitlement();
    expect(entitled).toBe(true);
    expect(isPlusEntitled()).toBe(true);
    const { record } = useEntitlementStore.getState();
    expect(record?.productId).toBe(PLUS_PRODUCT_ID);
    expect(record?.transactionId).toBe('tx-test-1');
  });

  it('an expired record does not entitle', async () => {
    // Past expiry AND the offline grace window (iap-store-recheck.test.ts
    // covers the grace window itself).
    await persistGrantDirectly({ expiresAt: Date.now() - EXPIRY_GRACE_MS - 1000 });
    resetEntitlementState();
    const entitled = await resolveEntitlement();
    expect(entitled).toBe(false);
  });

  it('a record for a different product does not entitle', async () => {
    await persistGrantDirectly({ productId: 'some_other_sku' });
    resetEntitlementState();
    // loadLocalRecord queries by PLUS_PRODUCT_ID, so a foreign SKU is not
    // even loaded, let alone granted.
    const entitled = await resolveEntitlement();
    expect(entitled).toBe(false);
  });
});

// ─── 3. Second family device via the family Yjs document ────────────────────

describe('second family device (CRDT sync path)', () => {
  // Device B is a member of the family the record was bought for — a synced
  // record only entitles inside its own family (iap-family-scope.test.ts).
  beforeEach(async () => {
    const { leaveFamily } = require('../src/identity/family');
    await leaveFamily();
    await require('expo-secure-store').setItemAsync(
      'groceryapp.family.membership',
      JSON.stringify({ familyId: 'fam-1', deviceId: 'device-b', joinedAt: 1 }),
    );
  });

  it('an entitlement record landing in the family doc entitles this device and persists', async () => {
    // Device B starts un-entitled and resolved (observer installed).
    const before = await resolveEntitlement();
    expect(before).toBe(false);

    // Device A's grant arrives: sync-manager applies remote updates
    // whole-document via Y.applyUpdate, which fires map observers exactly
    // like a local transact on the same map does.
    const doc = getDoc('__family__');
    doc.transact(() => {
      doc.getMap('entitlements').set(PLUS_PRODUCT_ID, {
        familyId: 'fam-1',
        productId: PLUS_PRODUCT_ID,
        platform: 'android',
        transactionId: 'tx-device-a',
        purchasedAt: Date.now(),
        expiresAt: null,
      });
    });

    // The observer persists asynchronously; drain microtasks.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(isPlusEntitled()).toBe(true);

    // And it survives device B's own relaunch (local table was written).
    resetEntitlementState();
    const afterRelaunch = await resolveEntitlement();
    expect(afterRelaunch).toBe(true);
    expect(useEntitlementStore.getState().record?.transactionId).toBe('tx-device-a');
  });

  it('a malformed or receipt-less doc record does not entitle', async () => {
    await resolveEntitlement();
    const doc = getDoc('__family__');
    doc.transact(() => {
      doc.getMap('entitlements').set(PLUS_PRODUCT_ID, {
        familyId: 'fam-1',
        productId: PLUS_PRODUCT_ID,
        platform: 'android',
        transactionId: '', // no transaction — forged/incomplete record
        purchasedAt: Date.now(),
        expiresAt: null,
      });
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(isPlusEntitled()).toBe(false);
  });
});
