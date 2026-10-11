/**
 * Entitlements used to never expire: purchaseToRecord always wrote
 * expiresAt: null and nothing ever asked the store again, so a cancelled,
 * lapsed or refunded subscription kept Plus forever, on every family device.
 *
 * Now the real iOS expiry is stored, and the purchasing device re-checks its
 * own store account at launch and on foreground. The revocation rule is
 * deliberately narrow — fail-open for the honest user:
 *   revoke ONLY on a well-formed, successful store answer containing no
 *   active Plus, for a record this device's store account owns.
 * Offline / store errors / malformed answers / pending payments / records
 * synced from another family device never revoke.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockRN = {
  Platform: { OS: 'ios' as string },
  AppState: {
    currentState: 'active' as string,
    handlers: [] as Array<(s: string) => void>,
    addEventListener: (_e: string, fn: (s: string) => void) => {
      mockRN.AppState.handlers.push(fn);
      return { remove: () => {} };
    },
  },
};
jest.mock('react-native', () => mockRN);
jest.mock('../src/sync/sync-manager', () => ({
  syncManager: { registerList: jest.fn() },
}));

const mockIap = {
  available: [] as any,
  failWith: null as Error | null,
  initConnection: jest.fn(async () => true),
  finishTransaction: jest.fn(async (_a: any) => undefined),
  getAvailablePurchases: jest.fn(async () => {
    if (mockIap.failWith) throw mockIap.failWith;
    return mockIap.available;
  }),
  purchaseUpdatedListener: jest.fn(() => ({ remove: () => {} })),
  purchaseErrorListener: jest.fn(() => ({ remove: () => {} })),
};
jest.mock('react-native-iap', () => mockIap);

import {
  useEntitlementStore,
  resolveEntitlement,
  verifyEntitlementWithStore,
  startEntitlementLifecycle,
  handlePurchaseUpdate,
  EXPIRY_GRACE_MS,
  PLUS_PRODUCT_ID,
} from '../src/config/entitlements';
import { getDoc } from '../src/sync/yjs-adapter';
import { getDatabase } from '../src/storage/database';

const { _resetDB } = require('@nozbe/watermelondb') as any;

const DAY = 24 * 60 * 60 * 1000;

async function seed(overrides: Record<string, unknown> = {}): Promise<void> {
  const collection = getDatabase().get('entitlements');
  await getDatabase().write(async () => {
    await collection.create((row: any) => {
      row.familyId = 'local';
      row.productId = PLUS_PRODUCT_ID;
      row.platform = 'ios';
      row.transactionId = 'tx-owned';
      row.purchasedAt = Date.now() - 30 * DAY;
      row.expiresAt = Date.now() + 300 * DAY;
      row.source = 'purchase';
      row.updatedAt = Date.now();
      Object.assign(row, overrides);
    });
  });
  await resolveEntitlement();
}

const iosActive = (overrides: Record<string, unknown> = {}) => ({
  id: 'tx-owned',
  productId: PLUS_PRODUCT_ID,
  transactionId: 'tx-owned',
  purchaseToken: 'jws',
  transactionDate: Date.now() - 30 * DAY,
  expirationDateIOS: Date.now() + 300 * DAY,
  purchaseState: 'purchased',
  ...overrides,
});

const familyEntry = () =>
  getDoc('__family__').getMap('entitlements').get(PLUS_PRODUCT_ID) as Record<string, unknown> | undefined;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  _resetDB();
  useEntitlementStore.setState({
    isPlus: false,
    record: null,
    resolution: 'unresolved',
    busy: false,
    lastError: null,
    pendingPayment: false,
  });
  mockRN.Platform.OS = 'ios';
  mockIap.available = [];
  mockIap.failWith = null;
  mockIap.finishTransaction.mockClear();
  mockIap.getAvailablePurchases.mockClear();
  getDoc('__family__').getMap('entitlements').delete(PLUS_PRODUCT_ID);
});

describe('expiry is stored', () => {
  it('records the iOS expirationDateIOS instead of null', async () => {
    const expires = Date.now() + 365 * DAY;
    await handlePurchaseUpdate(mockIap, iosActive({ expirationDateIOS: expires }) as any);
    expect(useEntitlementStore.getState().record?.expiresAt).toBe(expires);
    expect(familyEntry()?.expiresAt).toBe(expires);
  });

  it('a lapsed record still entitles inside the offline grace window', async () => {
    await seed({ expiresAt: Date.now() - 1 * DAY });
    expect(useEntitlementStore.getState().isPlus).toBe(true);
  });

  it('a record past expiry + grace does not entitle', async () => {
    await seed({ expiresAt: Date.now() - EXPIRY_GRACE_MS - DAY });
    expect(useEntitlementStore.getState().isPlus).toBe(false);
  });
});

describe('store re-check revokes only on a definitive answer', () => {
  it('revokes an owned record when the store answers with no active Plus', async () => {
    await seed();
    mockIap.available = [];
    await expect(verifyEntitlementWithStore()).resolves.toBe('none');
    expect(useEntitlementStore.getState().isPlus).toBe(false);
    // Local row gone: a relaunch stays un-entitled.
    await resolveEntitlement();
    expect(useEntitlementStore.getState().isPlus).toBe(false);
    // Family told: a tombstone, so other devices drop their synced copy.
    expect(familyEntry()?.revokedAt).toEqual(expect.any(Number));
  });

  it('revokes when the only Plus transaction has expired', async () => {
    await seed();
    mockIap.available = [iosActive({ expirationDateIOS: Date.now() - DAY })];
    await verifyEntitlementWithStore();
    expect(useEntitlementStore.getState().isPlus).toBe(false);
  });

  it('a store error (offline) does NOT revoke', async () => {
    await seed();
    mockIap.failWith = new Error('network-error');
    await expect(verifyEntitlementWithStore()).resolves.toBe('unknown');
    expect(useEntitlementStore.getState().isPlus).toBe(true);
  });

  it('a malformed store answer does NOT revoke', async () => {
    await seed();
    mockIap.available = null;
    await verifyEntitlementWithStore();
    expect(useEntitlementStore.getState().isPlus).toBe(true);
  });

  it('a pending payment does NOT revoke', async () => {
    await seed();
    mockIap.available = [iosActive({ purchaseState: 'pending' })];
    await verifyEntitlementWithStore();
    expect(useEntitlementStore.getState().isPlus).toBe(true);
    expect(useEntitlementStore.getState().pendingPayment).toBe(true);
  });

  it('a record synced from another family device is NOT revoked by this account', async () => {
    await seed({ source: 'sync' });
    mockIap.available = [];
    await verifyEntitlementWithStore();
    expect(useEntitlementStore.getState().isPlus).toBe(true);
  });

  it('a record bought on the other store is NOT revoked by this store', async () => {
    await seed({ platform: 'android' });
    mockIap.available = [];
    await verifyEntitlementWithStore();
    expect(useEntitlementStore.getState().isPlus).toBe(true);
  });

  it('does not run while a purchase is in flight', async () => {
    await seed();
    useEntitlementStore.setState({ busy: true });
    await expect(verifyEntitlementWithStore()).resolves.toBe('unknown');
    expect(mockIap.getAvailablePurchases).not.toHaveBeenCalled();
    expect(useEntitlementStore.getState().isPlus).toBe(true);
  });
});

describe('store re-check keeps an active subscription current', () => {
  it('a renewal updates the stored expiry and re-publishes it', async () => {
    await seed({ expiresAt: Date.now() + DAY });
    const renewed = Date.now() + 366 * DAY;
    mockIap.available = [iosActive({ expirationDateIOS: renewed, transactionId: 'tx-renewal' })];
    await expect(verifyEntitlementWithStore()).resolves.toBe('active');
    const { record, isPlus } = useEntitlementStore.getState();
    expect(isPlus).toBe(true);
    expect(record?.expiresAt).toBe(renewed);
    expect(record?.source).toBe('purchase');
    expect(familyEntry()?.expiresAt).toBe(renewed);
  });

  it('acknowledges an active Android purchase that was never acknowledged', async () => {
    mockRN.Platform.OS = 'android';
    await seed({ platform: 'android', expiresAt: null });
    mockIap.available = [
      {
        productId: PLUS_PRODUCT_ID,
        transactionId: 'tx-owned',
        purchaseToken: 'play',
        purchaseState: 'purchased',
        isAcknowledgedAndroid: false,
      },
    ];
    await verifyEntitlementWithStore();
    expect(mockIap.finishTransaction).toHaveBeenCalledTimes(1);
    expect(useEntitlementStore.getState().isPlus).toBe(true);
  });
});

describe('family devices follow the purchaser', () => {
  it('a revocation tombstone removes a synced record', async () => {
    await seed({ source: 'sync' });
    const doc = getDoc('__family__');
    doc.transact(() => {
      doc.getMap('entitlements').set(PLUS_PRODUCT_ID, {
        familyId: 'local',
        productId: PLUS_PRODUCT_ID,
        platform: 'ios',
        transactionId: 'tx-owned',
        purchasedAt: Date.now(),
        expiresAt: null,
        revokedAt: Date.now(),
      });
    });
    await flush();
    expect(useEntitlementStore.getState().isPlus).toBe(false);
    await resolveEntitlement();
    expect(useEntitlementStore.getState().isPlus).toBe(false);
  });

  it("a tombstone does not revoke this device's own store purchase", async () => {
    await seed({ source: 'purchase' });
    const doc = getDoc('__family__');
    doc.transact(() => {
      doc.getMap('entitlements').set(PLUS_PRODUCT_ID, {
        familyId: 'local',
        productId: PLUS_PRODUCT_ID,
        platform: 'ios',
        transactionId: 'someone-elses',
        purchasedAt: Date.now(),
        expiresAt: null,
        revokedAt: Date.now(),
      });
    });
    await flush();
    expect(useEntitlementStore.getState().isPlus).toBe(true);
  });
});

describe('startEntitlementLifecycle', () => {
  it('installs listeners, re-checks at launch, and again on return from background', async () => {
    await seed();
    mockIap.available = [iosActive()];
    await startEntitlementLifecycle();
    expect(mockIap.purchaseUpdatedListener).toHaveBeenCalledTimes(1);
    expect(mockIap.purchaseErrorListener).toHaveBeenCalledTimes(1);
    expect(mockIap.getAvailablePurchases).toHaveBeenCalledTimes(1);
    expect(mockRN.AppState.handlers).toHaveLength(1);

    // Subscription cancelled while the app sat in the background for a day.
    mockIap.available = [];
    const realNow = Date.now;
    const later = realNow() + DAY;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => later);
    try {
      mockRN.AppState.handlers[0]('background');
      mockRN.AppState.handlers[0]('active');
      await flush();
    } finally {
      spy.mockRestore();
    }
    expect(mockIap.getAvailablePurchases).toHaveBeenCalledTimes(2);
    expect(useEntitlementStore.getState().isPlus).toBe(false);

    // Idempotent: a second call installs nothing more.
    await startEntitlementLifecycle();
    expect(mockIap.purchaseUpdatedListener).toHaveBeenCalledTimes(1);
  });
});
