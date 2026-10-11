/**
 * Google Play subscription purchases must carry a REAL offer token.
 *
 * The purchase path used to hardcode `offerToken: ''` with a comment claiming
 * Play would resolve the offer in its own UI. It does not — Billing v5+ rejects
 * a request whose subscription offer has no token, so every Android purchase
 * would have failed after the store product existed.
 *
 * Nothing caught this. It was unreachable until react-native-iap was added at
 * all (it had been imported but never declared, so the paid tier threw on
 * launch), and the store-side failure that masks it — "SKU not found", because
 * no Play merchant account exists yet — happens strictly earlier.
 *
 * The token is only knowable at runtime: Play mints it per product and base
 * plan. So the guard is that we FETCH it, and that the two ways fetching can
 * fail are reported distinctly, since they need different fixes.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  resolveAndroidOffers,
  PLUS_PRODUCT_ID,
  PLUS_BASE_PLAN_ID,
  PurchaseUnavailableError,
} from '../src/config/entitlements';

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/**
 * A store response shaped like react-native-iap 15's fetchProducts.
 * Defaults to the base plan the paywall prices, so tests opt in to oddity.
 */
const productWith = (
  offers: Array<{ basePlanId?: string; offerId?: string | null; offerToken?: string | null }>,
  productStatusAndroid: string = 'ok',
) => ({
  fetchProducts: async () => [
    {
      id: PLUS_PRODUCT_ID,
      title: 'PantryRun Plus',
      productStatusAndroid,
      subscriptionOfferDetailsAndroid: offers,
    },
  ],
});

describe('resolveAndroidOffers', () => {
  it('returns the real offer token the store minted', async () => {
    const iap = productWith([{ basePlanId: PLUS_BASE_PLAN_ID, offerToken: 'REAL-TOKEN-abc123' }]);

    const offers = await resolveAndroidOffers(iap as never, 'android');

    expect(offers).toEqual([{ sku: PLUS_PRODUCT_ID, offerToken: 'REAL-TOKEN-abc123' }]);
    // The specific regression: never the empty string the old code sent.
    expect(offers![0].offerToken).not.toBe('');
  });

  it('is a no-op on iOS, which keys off apple.sku instead', async () => {
    const iap = { fetchProducts: jest.fn() };

    await expect(resolveAndroidOffers(iap as never, 'ios')).resolves.toBeUndefined();
    expect(iap.fetchProducts).not.toHaveBeenCalled();
  });

  it('reports a nonexistent product from the placeholder the bridge really returns', async () => {
    // NOT `fetchProducts: () => []`. A missing product still comes back, as a
    // placeholder with productStatusAndroid 'not-found' and an EMPTY offers
    // array (subscriptionOfferDetailsAndroid is non-optional, types.d.ts:1164).
    // An earlier version of this test used the empty-array shape, which
    // production never produces — so it passed while the real path threw the
    // wrong error. This is the exact state the app is in today.
    const iap = productWith([], 'not-found');

    await expect(resolveAndroidOffers(iap as never, 'android')).rejects.toThrow(
      /does not exist in the store/,
    );
    await expect(resolveAndroidOffers(iap as never, 'android')).rejects.toThrow(
      /merchant account/,
    );
  });

  it('separates "no offers for your account" from "product missing"', async () => {
    const iap = productWith([], 'no-offers-available');
    await expect(resolveAndroidOffers(iap as never, 'android')).rejects.toThrow(
      /no offers available to this account/,
    );
  });

  it('a THROWN store error never reaches the buyer verbatim', async () => {
    // This is the real failure path, not the null one: every failure inside
    // fetchProducts rethrows a PurchaseError carrying the raw native message
    // (react-native-iap src/index.ts:955-974). Airplane mode, or a device not
    // signed into Play, lands here. Fetching is NEW to the purchase path, so
    // an uncaught native string in the Alert would be a new leak.
    const iap = {
      fetchProducts: async () => {
        throw new Error('E_NETWORK: BillingClient: Service disconnected (code 2)');
      },
    };

    const e = await resolveAndroidOffers(iap as never, 'android').catch((x) => x);
    expect(e).toBeInstanceOf(PurchaseUnavailableError);
    expect((e as Error).message).toMatch(/BillingClient/); // operator keeps the detail
    expect((e as PurchaseUnavailableError).userMessage).not.toMatch(/BillingClient|E_NETWORK/);
    expect((e as PurchaseUnavailableError).userMessage).toMatch(/Could not reach the store/);
  });

  it('a null result is a failed lookup, not a missing product', async () => {
    const iap = { fetchProducts: async () => null };
    // Operator detail says what actually happened; the buyer is told to retry,
    // not sent to the Play Console for what is usually a network blip.
    await expect(resolveAndroidOffers(iap as never, 'android')).rejects.toThrow(
      /returned null/,
    );
    await expect(resolveAndroidOffers(iap as never, 'android')).rejects.not.toThrow(
      /merchant account/,
    );
    const e = await resolveAndroidOffers(iap as never, 'android').catch((x) => x);
    expect((e as PurchaseUnavailableError).userMessage).toMatch(/Could not reach the store/);
  });

  it('never shows Play Console operator text to a buyer', async () => {
    // lastError is rendered into Alert.alert; the operator detail belongs in logs.
    const iap = productWith([], 'not-found');
    try {
      await resolveAndroidOffers(iap as never, 'android');
      throw new Error('expected a rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(PurchaseUnavailableError);
      const user = (e as PurchaseUnavailableError).userMessage;
      expect(user).not.toMatch(/Play Console|merchant account|base plan|sideload/i);
      expect(user.length).toBeGreaterThan(0);
    }
  });

  it('distinguishes "product exists but has no sellable base plan"', async () => {
    const iap = productWith([]);

    await expect(resolveAndroidOffers(iap as never, 'android')).rejects.toThrow(
      /no bare base-plan offer/,
    );
  });

  it('rejects an empty or null token from the store instead of passing it through', async () => {
    // Defends the exact old bug from re-entering via the store rather than the
    // source: an offer whose token is empty must not be forwarded.
    for (const bad of ['', null, undefined]) {
      const iap = productWith([{ basePlanId: PLUS_BASE_PLAN_ID, offerToken: bad as never }]);
      await expect(resolveAndroidOffers(iap as never, 'android')).rejects.toThrow(
        /no bare base-plan offer/,
      );
      // And the diagnostic must SAY the token was empty. Counting only the
      // offers that survived the filter would report "plans: none" here, which
      // reads as a missing base plan and sends the operator to the wrong screen.
      await expect(resolveAndroidOffers(iap as never, 'android')).rejects.toThrow(
        /1 dropped for an empty offerToken/,
      );
    }
  });

  it('buys the base plan the paywall priced, not whatever the store listed first', async () => {
    // PLUS_PRICE_DISPLAY is hardcoded onto the Subscribe button, so charging a
    // promotional offer instead would advertise one price and bill another.
    // Play returns one entry PER OFFER, and a Console-side change alone can
    // reorder this array — an earlier version took offers[0] and called that
    // "deterministic", which is exactly letting store order pick the price.
    const iap = productWith([
      { basePlanId: PLUS_BASE_PLAN_ID, offerId: 'promo-intro', offerToken: 'INTRO' },
      { basePlanId: PLUS_BASE_PLAN_ID, offerId: null, offerToken: 'BASE' },
      { basePlanId: 'monthly', offerId: null, offerToken: 'WRONG-PLAN' },
    ]);

    const offers = await resolveAndroidOffers(iap as never, 'android');

    expect(offers).toEqual([{ sku: PLUS_PRODUCT_ID, offerToken: 'BASE' }]);
  });

  it('does not let store ORDER decide the price, in either arrangement', async () => {
    // The single-arrangement version of this test could not tell "prefer the
    // bare base plan" apart from "take the last entry" — a mutation to
    // forPlan[forPlan.length - 1] kept the whole suite green, on a money path.
    // Both orderings must land on the same offer.
    const promo = { basePlanId: PLUS_BASE_PLAN_ID, offerId: 'promo-intro', offerToken: 'INTRO' };
    const base = { basePlanId: PLUS_BASE_PLAN_ID, offerId: null, offerToken: 'BASE' };

    for (const arrangement of [[promo, base], [base, promo]]) {
      const offers = await resolveAndroidOffers(productWith(arrangement) as never, 'android');
      expect(offers).toEqual([{ sku: PLUS_PRODUCT_ID, offerToken: 'BASE' }]);
    }
  });

  it('treats an empty-string offerId as the bare base plan, not a promo', async () => {
    // If Play spells "no offer" as '' rather than null and this were not
    // handled, the bare plan would never match and EVERY purchase would fail.
    const iap = productWith([{ basePlanId: PLUS_BASE_PLAN_ID, offerId: '', offerToken: 'BASE' }]);
    const offers = await resolveAndroidOffers(iap as never, 'android');
    expect(offers).toEqual([{ sku: PLUS_PRODUCT_ID, offerToken: 'BASE' }]);
  });

  it('refuses to guess when the plan has ONLY promotional offers', async () => {
    // Charging a promo when the button says PLUS_PRICE_DISPLAY is a money bug.
    // Failing loudly with a diagnosable message is the correct outcome.
    const iap = productWith([
      { basePlanId: PLUS_BASE_PLAN_ID, offerId: 'promo-a', offerToken: 'A' },
      { basePlanId: PLUS_BASE_PLAN_ID, offerId: 'promo-b', offerToken: 'B' },
    ]);
    await expect(resolveAndroidOffers(iap as never, 'android')).rejects.toThrow(
      /2 matched the plan but all carried an offerId/,
    );
  });

  it('rejects when the priced base plan has no offer, naming what it did see', async () => {
    const iap = productWith([{ basePlanId: 'monthly', offerId: null, offerToken: 'other' }]);
    await expect(resolveAndroidOffers(iap as never, 'android')).rejects.toThrow(
      new RegExp(`no bare base-plan offer for "${PLUS_BASE_PLAN_ID}"`),
    );
    await expect(resolveAndroidOffers(iap as never, 'android')).rejects.toThrow(/monthly/);
  });

  it('asks the store for the right thing', async () => {
    const fetchProducts = jest.fn(async (_opts: { skus: string[]; type: string }) => [
      {
        id: PLUS_PRODUCT_ID,
        productStatusAndroid: 'ok',
        subscriptionOfferDetailsAndroid: [
          { basePlanId: PLUS_BASE_PLAN_ID, offerId: null, offerToken: 'tok' },
        ],
      },
    ]);

    await resolveAndroidOffers({ fetchProducts } as never, 'android');

    // A wrong `type` would return nothing and read as a missing product.
    expect(fetchProducts).toHaveBeenCalledWith({ skus: [PLUS_PRODUCT_ID], type: 'subs' });
  });
});

/**
 * The tests above prove the RESOLVER works. They do not prove it is WIRED.
 *
 * Reinstating the original bug — putting `offerToken: ''` back at the call site
 * inside purchasePlus — left all of them green, because the mutation never
 * touched resolveAndroidOffers. Only the source grep caught it, and a grep is
 * a weak guard: rename the variable and it passes while the bug is back.
 *
 * So drive purchasePlus itself and assert on what requestPurchase actually
 * received. This is the test that fails if the wiring is undone.
 */
describe('purchasePlus passes the resolved token to the store', () => {
  it('requestPurchase receives the real offer token, never an empty string', async () => {
    jest.resetModules();

    type PurchaseArg = {
      type: string;
      request: {
        apple: { sku: string };
        google: {
          skus: string[];
          subscriptionOffers: Array<{ sku: string; offerToken: string }>;
        };
      };
    };
    const requestPurchase = jest.fn(async (_arg: PurchaseArg) => undefined);
    let onPurchase: ((p: unknown) => void) | undefined;

    jest.doMock('react-native-iap', () => ({
      initConnection: async () => true,
      endConnection: async () => true,
      fetchProducts: async () => [
        {
          id: 'pantryrun_plus_annual',
          productStatusAndroid: 'ok',
          subscriptionOfferDetailsAndroid: [
            { basePlanId: 'annual', offerId: null, offerToken: 'WIRED-TOKEN-xyz' },
          ],
        },
      ],
      requestPurchase,
      purchaseUpdatedListener: (cb: (p: unknown) => void) => {
        onPurchase = cb;
        return { remove: () => {} };
      },
      purchaseErrorListener: () => ({ remove: () => {} }),
      finishTransaction: async () => undefined,
    }));
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));

    const mod = await import('../src/config/entitlements');
    // No .catch() swallow: a throw anywhere in the grant path must fail this test.
    const pending = mod.purchasePlus();

    // Let the lazy imports and the product fetch settle, then complete the flow.
    await new Promise((r) => setTimeout(r, 0));
    onPurchase?.({ productId: 'pantryrun_plus_annual', purchaseToken: 'tok', transactionId: 't1', purchaseState: 'purchased' });
    // The purchase must actually succeed, not merely not-throw.
    await expect(pending).resolves.toBe(true);

    expect(requestPurchase).toHaveBeenCalledWith({
      request: {
        apple: { sku: 'pantryrun_plus_annual' },
        google: {
          skus: ['pantryrun_plus_annual'],
          subscriptionOffers: [
            { sku: 'pantryrun_plus_annual', offerToken: 'WIRED-TOKEN-xyz' },
          ],
        },
      },
      type: 'subs',
    });
    const sent = requestPurchase.mock.calls[0][0].request.google.subscriptionOffers;

    expect(sent[0].offerToken).toBe('WIRED-TOKEN-xyz');
    expect(sent[0].offerToken).not.toBe('');
  });

});

/** Builds a purchasePlus harness whose store events the test drives by hand.
 *  Emitted Plus purchases carry purchaseState: v15 always sets it, and only
 *  'purchased' may grant (see iap-purchase-lifecycle.test.ts). */
async function harness() {
  jest.resetModules();
  const finishTransaction = jest.fn(async () => undefined);
  let onPurchase: ((p: unknown) => void) | undefined;
  let onError: ((e: unknown) => void) | undefined;

  jest.doMock('react-native-iap', () => ({
    initConnection: async () => true,
    endConnection: async () => true,
    fetchProducts: async () => [
      {
        id: 'pantryrun_plus_annual',
        productStatusAndroid: 'ok',
        subscriptionOfferDetailsAndroid: [
          { basePlanId: 'annual', offerId: null, offerToken: 'TOK' },
        ],
      },
    ],
    requestPurchase: jest.fn(async () => undefined),
    purchaseUpdatedListener: (cb: (p: unknown) => void) => {
      onPurchase = cb;
      return { remove: () => {} };
    },
    purchaseErrorListener: (cb: (e: unknown) => void) => {
      onError = cb;
      return { remove: () => {} };
    },
    finishTransaction,
  }));
  jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));

  const mod = await import('../src/config/entitlements');
  const pending = mod.purchasePlus();
  await new Promise((r) => setTimeout(r, 0));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    pending,
    finishTransaction,
    settle,
    emit: (p: unknown) => onPurchase?.(p),
    fail: (e: unknown) => onError?.(e),
  };
}

describe('buffered store events must not settle the wrong purchase', () => {
  it('ignores a buffered ERROR for a different product', async () => {
    // The mirror of the success case, and the same money bug: rejecting here
    // tears down both listeners, so the real purchase lands unheard, never
    // gets finishTransaction, and Play auto-refunds it in ~3 days.
    const h = await harness();
    h.fail({ productId: 'some_other_sku', code: 'E_UNKNOWN', message: 'stale' });
    await h.settle();

    h.emit({ productId: 'pantryrun_plus_annual', purchaseToken: 'tok', transactionId: 't1', purchaseState: 'purchased' });
    await expect(h.pending).resolves.toBe(true);
    expect(h.finishTransaction).toHaveBeenCalledTimes(1);
  });

  it('does NOT hang on an event that names no product', async () => {
    // PurchaseError.productId is optional and nullable (types.d.ts:1319), and a
    // user cancellation typically arrives with none. A strict equality guard
    // would drop it, leaving the promise unsettled, `busy: true` stuck, no
    // alert, and no recovery short of restarting the app.
    const h = await harness();
    h.fail({ code: 'E_USER_CANCELLED', message: 'User cancelled' });
    await expect(h.pending).resolves.toBe(false);
  });

  it('matches on the ids array too, not just productId', async () => {
    const h = await harness();
    h.emit({ ids: ['pantryrun_plus_annual'], purchaseToken: 'tok', transactionId: 't2', purchaseState: 'purchased' });
    await expect(h.pending).resolves.toBe(true);
    expect(h.finishTransaction).toHaveBeenCalledTimes(1);
  });

  it('reads ids when it is the ONLY identity, and skips a stranger named there', async () => {
    // The positive case above cannot prove `ids` is consulted at all: with no
    // productId the event carries no identity the narrow version can see, so
    // the deliberate "settle rather than hang" fallback resolves it either way.
    // Restricting the identity lookup to productId kept that test green.
    // THIS is the discriminating case — a foreign product named only in `ids`
    // must be skipped, which is impossible unless `ids` is actually read.
    const h = await harness();
    h.emit({ ids: ['some_other_sku'], purchaseToken: 'stale', transactionId: 'x' });
    await h.settle();
    expect(h.finishTransaction).not.toHaveBeenCalled();

    h.emit({ productId: 'pantryrun_plus_annual', purchaseToken: 'tok', transactionId: 't3', purchaseState: 'purchased' });
    await expect(h.pending).resolves.toBe(true);
    expect(h.finishTransaction).toHaveBeenCalledTimes(1);
  });

  it('reads productIds on errors, which is where PurchaseError carries them', async () => {
    // PurchaseError has productIds, not ids (types.d.ts:1320).
    const h = await harness();
    h.fail({ productIds: ['some_other_sku'], code: 'E_UNKNOWN', message: 'stale' });
    await h.settle();

    h.emit({ productId: 'pantryrun_plus_annual', purchaseToken: 'tok', transactionId: 't4', purchaseState: 'purchased' });
    await expect(h.pending).resolves.toBe(true);
  });
});

describe('purchasePlus passes the resolved token to the store (cont.)', () => {
  it('ignores a buffered purchase for a DIFFERENT product instead of finishing it', async () => {
    jest.resetModules();

    const finishTransaction = jest.fn(async () => undefined);
    let onPurchase: ((p: unknown) => void) | undefined;

    jest.doMock('react-native-iap', () => ({
      initConnection: async () => true,
      endConnection: async () => true,
      fetchProducts: async () => [
        {
          id: 'pantryrun_plus_annual',
          productStatusAndroid: 'ok',
          subscriptionOfferDetailsAndroid: [
            { basePlanId: 'annual', offerId: null, offerToken: 'TOK' },
          ],
        },
      ],
      requestPurchase: jest.fn(async () => undefined),
      purchaseUpdatedListener: (cb: (p: unknown) => void) => {
        onPurchase = cb;
        return { remove: () => {} };
      },
      purchaseErrorListener: () => ({ remove: () => {} }),
      finishTransaction,
    }));
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));

    const mod = await import('../src/config/entitlements');
    const pending = mod.purchasePlus();
    await new Promise((r) => setTimeout(r, 0));

    // Events emitted with no JS listener attached are buffered natively and
    // flushed to whoever attaches first, so this is the FIRST thing the
    // listener sees. Finishing it would finish someone else's transaction and
    // return true without ever unlocking anything.
    onPurchase?.({ productId: 'some_other_sku', purchaseToken: 'stale', transactionId: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(finishTransaction).not.toHaveBeenCalled();

    // Still waiting — the real event resolves it.
    onPurchase?.({ productId: 'pantryrun_plus_annual', purchaseToken: 'tok', transactionId: 't1', purchaseState: 'purchased' });
    await expect(pending).resolves.toBe(true);
    expect(finishTransaction).toHaveBeenCalledTimes(1);
  });
});
