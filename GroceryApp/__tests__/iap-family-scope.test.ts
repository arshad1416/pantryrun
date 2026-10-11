/**
 * "One purchase unlocks the family" — the family it was bought for.
 *
 * computeIsPlus never looked at familyId, so a device that left the family
 * (or joined a different one) kept Plus forever through the record the family
 * document had synced to it. A synced record now entitles only while
 * record.familyId matches the device's current family. The buyer's own store
 * purchase is not family-scoped: it is theirs, and the store re-check governs it.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import {
  useEntitlementStore,
  resolveEntitlement,
  refreshFamilyScope,
  PLUS_PRODUCT_ID,
} from '../src/config/entitlements';
import { getDatabase } from '../src/storage/database';
import { getDoc } from '../src/sync/yjs-adapter';
import { leaveFamily } from '../src/identity/family';

const SecureStore = require('expo-secure-store');
const { _resetDB } = require('@nozbe/watermelondb') as any;

async function joinFamily(familyId: string): Promise<void> {
  await leaveFamily(); // clears the module's cached membership
  await SecureStore.setItemAsync(
    'groceryapp.family.membership',
    JSON.stringify({ familyId, deviceId: 'this-device', joinedAt: 1 }),
  );
}

async function seed(source: 'sync' | 'purchase', familyId = 'fam-A'): Promise<void> {
  const collection = getDatabase().get('entitlements');
  await getDatabase().write(async () => {
    await collection.create((row: any) => {
      row.familyId = familyId;
      row.productId = PLUS_PRODUCT_ID;
      row.platform = 'ios';
      row.transactionId = 'tx-1';
      row.purchasedAt = Date.now();
      row.expiresAt = null;
      row.source = source;
      row.updatedAt = Date.now();
    });
  });
}

beforeEach(async () => {
  _resetDB();
  useEntitlementStore.setState({ isPlus: false, record: null, resolution: 'unresolved' });
  await joinFamily('fam-A');
});

describe('a synced record is scoped to its family', () => {
  it('entitles a member of the family it was bought for', async () => {
    await seed('sync', 'fam-A');
    expect(await resolveEntitlement()).toBe(true);
  });

  it('does not entitle a device in a different family', async () => {
    await seed('sync', 'fam-A');
    await joinFamily('fam-B');
    expect(await resolveEntitlement()).toBe(false);
  });

  it('stops entitling once the device leaves the family', async () => {
    await seed('sync', 'fam-A');
    expect(await resolveEntitlement()).toBe(true);

    await leaveFamily();
    await refreshFamilyScope();
    expect(useEntitlementStore.getState().isPlus).toBe(false);

    // ...and rejoining restores it, nothing was destroyed.
    await joinFamily('fam-A');
    await refreshFamilyScope();
    expect(useEntitlementStore.getState().isPlus).toBe(true);
  });

  it("ignores another family's record arriving through the family document", async () => {
    await resolveEntitlement();
    const doc = getDoc('__family__');
    doc.transact(() => {
      doc.getMap('entitlements').set(PLUS_PRODUCT_ID, {
        familyId: 'fam-OTHER',
        productId: PLUS_PRODUCT_ID,
        platform: 'ios',
        transactionId: 'tx-foreign',
        purchasedAt: Date.now(),
        expiresAt: null,
      });
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(useEntitlementStore.getState().isPlus).toBe(false);
  });
});

describe("the buyer's own purchase is not family-scoped", () => {
  it('keeps Plus after the buyer leaves the family', async () => {
    await seed('purchase', 'fam-A');
    await leaveFamily();
    expect(await resolveEntitlement()).toBe(true);
  });
});
