/**
 * Store events outlive the purchase sheet.
 *
 * Listeners used to exist only while purchasePlus() was awaiting, and
 * purchaseState was never read. So:
 *   - a Play "pending" payment (cash, bank transfer) was granted Plus at once,
 *     before any money moved, and finishTransaction was attempted on it;
 *   - when that payment completed later, nobody was listening: no grant, no
 *     acknowledgement, and Play auto-refunds unacknowledged purchases after
 *     ~3 days;
 *   - restorePlus() granted without acknowledging, so a purchase that was
 *     never acknowledged stayed refundable.
 *
 * These tests drive the module through a mocked react-native-iap.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../src/sync/sync-manager', () => ({
  syncManager: { registerList: jest.fn() },
}));

type Listener = (x: any) => void;
const iapMock = {
  updated: [] as Listener[],
  errored: [] as Listener[],
  onRequest: (() => {}) as () => void,
  available: [] as any[],
  initConnection: jest.fn(async () => true),
  fetchProducts: jest.fn(async () => [
    {
      id: 'pantryrun_plus_annual',
      productStatusAndroid: 'ok',
      subscriptionOfferDetailsAndroid: [{ basePlanId: 'annual', offerId: null, offerToken: 'TOKEN' }],
    },
  ]),
  finishTransaction: jest.fn(async (_args: any) => undefined),
  getAvailablePurchases: jest.fn(async () => iapMock.available),
  purchaseUpdatedListener: jest.fn((fn: Listener) => {
    iapMock.updated.push(fn);
    return { remove: () => {} };
  }),
  purchaseErrorListener: jest.fn((fn: Listener) => {
    iapMock.errored.push(fn);
    return { remove: () => {} };
  }),
  requestPurchase: jest.fn(async () => {
    // Deliver asynchronously, like the native bridge.
    setTimeout(() => iapMock.onRequest(), 0);
    return null;
  }),
};
jest.mock('react-native-iap', () => iapMock);

import {
  useEntitlementStore,
  purchasePlus,
  restorePlus,
  classifyStorePurchases,
  PLUS_PRODUCT_ID,
} from '../src/config/entitlements';

const { _resetDB } = require('@nozbe/watermelondb') as any;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const emitUpdate = (p: any) => iapMock.updated.forEach((fn) => fn(p));
const emitError = (e: any) => iapMock.errored.forEach((fn) => fn(e));

const androidPurchase = (overrides: Record<string, unknown> = {}) => ({
  id: 'GPA.1234',
  productId: PLUS_PRODUCT_ID,
  transactionId: 'GPA.1234',
  purchaseToken: 'play-token',
  transactionDate: Date.now(),
  purchaseState: 'purchased',
  isAcknowledgedAndroid: false,
  isAutoRenewing: true,
  platform: 'android',
  ...overrides,
});

beforeEach(() => {
  _resetDB();
  useEntitlementStore.setState({
    isPlus: false,
    record: null,
    resolution: 'resolved',
    busy: false,
    lastError: null,
    pendingPayment: false,
  });
  iapMock.finishTransaction.mockClear();
  iapMock.available = [];
  iapMock.onRequest = () => {};
});

describe('purchasePlus reads purchaseState', () => {
  it('grants and acknowledges a completed purchase', async () => {
    iapMock.onRequest = () => emitUpdate(androidPurchase());
    const ok = await purchasePlus();
    expect(ok).toBe(true);
    expect(useEntitlementStore.getState().isPlus).toBe(true);
    expect(iapMock.finishTransaction).toHaveBeenCalledTimes(1);
    expect(iapMock.finishTransaction.mock.calls[0][0]).toMatchObject({ isConsumable: false });
  });

  it('a pending payment is not a grant, not an error, and is not finished', async () => {
    iapMock.onRequest = () => emitUpdate(androidPurchase({ purchaseState: 'pending' }));
    const ok = await purchasePlus();
    expect(ok).toBe(false);
    const s = useEntitlementStore.getState();
    expect(s.isPlus).toBe(false);
    expect(s.pendingPayment).toBe(true);
    expect(s.lastError).toBeNull();
    expect(s.busy).toBe(false);
    expect(iapMock.finishTransaction).not.toHaveBeenCalled();
  });

  it('a pending payment that completes after the sheet closed is granted and acknowledged', async () => {
    iapMock.onRequest = () => emitUpdate(androidPurchase({ purchaseState: 'pending' }));
    await purchasePlus();
    expect(useEntitlementStore.getState().isPlus).toBe(false);

    // Hours later, with no purchasePlus() in flight, Play reports completion.
    emitUpdate(androidPurchase({ purchaseState: 'purchased' }));
    await flush();

    const s = useEntitlementStore.getState();
    expect(s.isPlus).toBe(true);
    expect(s.pendingPayment).toBe(false);
    expect(iapMock.finishTransaction).toHaveBeenCalledTimes(1);
  });

  it('an unknown purchase state is not granted', async () => {
    iapMock.onRequest = () => emitUpdate(androidPurchase({ purchaseState: 'unknown' }));
    const ok = await purchasePlus();
    expect(ok).toBe(false);
    expect(useEntitlementStore.getState().isPlus).toBe(false);
    expect(useEntitlementStore.getState().lastError).toMatch(/could not confirm/);
  });

  it('iOS Ask to Buy (deferred-payment error) reads as pending, not failure', async () => {
    iapMock.onRequest = () =>
      emitError({ code: 'deferred-payment', message: 'Deferred', productId: PLUS_PRODUCT_ID });
    const ok = await purchasePlus();
    expect(ok).toBe(false);
    expect(useEntitlementStore.getState().pendingPayment).toBe(true);
    expect(useEntitlementStore.getState().lastError).toBeNull();
  });

  it('a user cancellation is silent', async () => {
    iapMock.onRequest = () => emitError({ code: 'user-cancelled', message: 'User cancelled' });
    const ok = await purchasePlus();
    expect(ok).toBe(false);
    expect(useEntitlementStore.getState().lastError).toBeNull();
  });

  it('an event for another product neither grants nor settles the purchase', async () => {
    iapMock.onRequest = () => {
      emitUpdate(androidPurchase({ productId: 'someone_else', transactionId: 'X' }));
      emitUpdate(androidPurchase());
    };
    const ok = await purchasePlus();
    expect(ok).toBe(true);
    expect(useEntitlementStore.getState().record?.transactionId).toBe('GPA.1234');
  });
});

describe('restorePlus acknowledges before granting', () => {
  it('finishes an unacknowledged purchase before granting', async () => {
    iapMock.available = [androidPurchase({ isAcknowledgedAndroid: false })];
    let plusAtFinish: boolean | null = null;
    iapMock.finishTransaction.mockImplementationOnce(async () => {
      plusAtFinish = useEntitlementStore.getState().isPlus;
    });
    const ok = await restorePlus();
    expect(ok).toBe(true);
    expect(iapMock.finishTransaction).toHaveBeenCalledTimes(1);
    expect(plusAtFinish).toBe(false); // acknowledged first, granted after
    expect(useEntitlementStore.getState().isPlus).toBe(true);
  });

  it('does not re-finish an already acknowledged purchase', async () => {
    iapMock.available = [androidPurchase({ isAcknowledgedAndroid: true })];
    expect(await restorePlus()).toBe(true);
    expect(iapMock.finishTransaction).not.toHaveBeenCalled();
  });

  it('a pending purchase is reported as pending, not restored', async () => {
    iapMock.available = [androidPurchase({ purchaseState: 'pending' })];
    expect(await restorePlus()).toBe(false);
    const s = useEntitlementStore.getState();
    expect(s.isPlus).toBe(false);
    expect(s.pendingPayment).toBe(true);
    expect(s.lastError).toBeNull();
  });
});

describe('classifyStorePurchases', () => {
  const now = 1_800_000_000_000;
  it('only a well-formed empty answer is "none"', () => {
    expect(classifyStorePurchases([], now).kind).toBe('none');
    expect(classifyStorePurchases(null, now).kind).toBe('unknown');
    expect(classifyStorePurchases(undefined, now).kind).toBe('unknown');
  });
  it('ignores other products', () => {
    expect(classifyStorePurchases([androidPurchase({ productId: 'x' })], now).kind).toBe('none');
  });
  it('an expired or revoked iOS transaction is not active', () => {
    const ios = { productId: PLUS_PRODUCT_ID, transactionId: 't', purchaseState: 'purchased' };
    expect(classifyStorePurchases([{ ...ios, expirationDateIOS: now - 1 }], now).kind).toBe('none');
    expect(classifyStorePurchases([{ ...ios, revocationDateIOS: now - 1 }], now).kind).toBe('none');
    expect(classifyStorePurchases([{ ...ios, expirationDateIOS: now + 1 }], now).kind).toBe('active');
  });
  it('a suspended Android subscription is not active', () => {
    expect(classifyStorePurchases([androidPurchase({ isSuspendedAndroid: true })], now).kind).toBe('none');
  });
  it('an unreadable state is unknown, never none', () => {
    expect(classifyStorePurchases([androidPurchase({ purchaseState: 'unknown' })], now).kind).toBe('unknown');
  });
});
