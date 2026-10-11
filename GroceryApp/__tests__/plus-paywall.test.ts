/**
 * Apple Guideline 3.1.2 paywall.
 *
 * Plus used to be sold from a system Alert (GroceryListScreen) and two bare
 * buttons (SettingsScreen), both showing a hard-coded "$14.99/year" and none
 * of the required disclosures: no plan name, no store-localized price or
 * period, no auto-renewal / 24-hour cancellation terms, no charged account,
 * no manage/cancel path, no Terms of Use or Privacy Policy links. That is a
 * standard App Review rejection for auto-renewing subscriptions.
 *
 * These pin the pure copy/price logic and that both selling surfaces go
 * through the one PlusPaywall component.
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mockFetchProducts = jest.fn(async (_req: any): Promise<unknown> => []);
jest.mock('react-native-iap', () => ({
  initConnection: async () => true,
  fetchProducts: (req: any) => mockFetchProducts(req),
}));

import {
  describePlusProduct,
  parseBillingPeriod,
  loadPlusProduct,
  useEntitlementStore,
  PLUS_PRODUCT_ID,
  PLUS_PRICE_DISPLAY,
} from '../src/config/entitlements';
import {
  paywallPricing,
  paywallTerms,
  manageSubscriptionsUrl,
  TERMS_OF_USE_URL,
  PRIVACY_POLICY_URL,
} from '../src/config/plus-paywall';

const APP_ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');

const iosProduct = {
  id: PLUS_PRODUCT_ID,
  platform: 'ios',
  type: 'subs',
  title: 'PantryRun Plus',
  displayNameIOS: 'PantryRun Plus Annual',
  displayPrice: 'CA$19.99',
  subscriptionPeriodUnitIOS: 'year',
  subscriptionPeriodNumberIOS: '1',
};

const androidProduct = {
  id: PLUS_PRODUCT_ID,
  platform: 'android',
  type: 'subs',
  title: 'PantryRun Plus (PantryRun)',
  nameAndroid: 'PantryRun Plus',
  // Product-level displayPrice may describe a promo offer, not the base plan.
  displayPrice: '€0.99',
  subscriptionOfferDetailsAndroid: [
    {
      basePlanId: 'annual',
      offerId: 'intro',
      offerToken: 'promo',
      pricingPhases: {
        pricingPhaseList: [{ formattedPrice: '€0.99', billingPeriod: 'P1M', recurrenceMode: 2 }],
      },
    },
    {
      basePlanId: 'annual',
      offerId: null,
      offerToken: 'base',
      pricingPhases: {
        pricingPhaseList: [{ formattedPrice: '€16,99', billingPeriod: 'P1Y', recurrenceMode: 1 }],
      },
    },
  ],
};

describe('store product → paywall price', () => {
  it('reads the iOS localized price and period', () => {
    expect(describePlusProduct([iosProduct], 'ios')).toEqual({
      title: 'PantryRun Plus Annual',
      displayPrice: 'CA$19.99',
      periodUnit: 'year',
      periodCount: 1,
    });
  });

  it("reads Android's bare base plan, not a promo offer", () => {
    expect(describePlusProduct([androidProduct], 'android')).toEqual({
      title: 'PantryRun Plus',
      displayPrice: '€16,99',
      periodUnit: 'year',
      periodCount: 1,
    });
  });

  it('returns null (keep fallback) for a missing or incomplete product', () => {
    expect(describePlusProduct(null, 'ios')).toBeNull();
    expect(describePlusProduct([], 'ios')).toBeNull();
    expect(describePlusProduct([{ ...iosProduct, subscriptionPeriodUnitIOS: null }], 'ios')).toBeNull();
    expect(
      describePlusProduct([{ ...androidProduct, subscriptionOfferDetailsAndroid: [] }], 'android'),
    ).toBeNull();
  });

  it('parses Play billing periods', () => {
    expect(parseBillingPeriod('P1Y')).toEqual({ unit: 'year', count: 1 });
    expect(parseBillingPeriod('P3M')).toEqual({ unit: 'month', count: 3 });
    expect(parseBillingPeriod('P1W')).toEqual({ unit: 'week', count: 1 });
    expect(parseBillingPeriod('P1Y6M')).toBeNull();
    expect(parseBillingPeriod('')).toBeNull();
  });

  it('loadPlusProduct puts the localized product in the store', async () => {
    mockFetchProducts.mockResolvedValueOnce([androidProduct]);
    const info = await loadPlusProduct();
    expect(info?.displayPrice).toBe('€16,99');
    expect(useEntitlementStore.getState().product?.displayPrice).toBe('€16,99');
    expect(mockFetchProducts).toHaveBeenCalledWith({ skus: [PLUS_PRODUCT_ID], type: 'subs' });
  });

  it('loadPlusProduct failure keeps the fallback and does not throw', async () => {
    useEntitlementStore.setState({ product: null });
    mockFetchProducts.mockRejectedValueOnce(new Error('offline'));
    await expect(loadPlusProduct()).resolves.toBeNull();
    expect(useEntitlementStore.getState().product).toBeNull();
  });
});

describe('paywall pricing and disclosures', () => {
  it('uses the hard-coded price only as a loading fallback', () => {
    const fallback = paywallPricing(null);
    expect(fallback.priceLabel).toBe(PLUS_PRICE_DISPLAY);
    expect(fallback.fromStore).toBe(false);

    const live = paywallPricing({
      title: 'PantryRun Plus Annual',
      displayPrice: 'CA$19.99',
      periodUnit: 'year',
      periodCount: 1,
    });
    expect(live).toMatchObject({
      planName: 'PantryRun Plus Annual',
      priceLabel: 'CA$19.99/year',
      renews: 'annually',
      fromStore: true,
    });
  });

  it.each(['ios', 'android'])('%s terms state renewal, 24h cancellation, charged account, manage path', (os) => {
    const product = { title: 'P', displayPrice: 'CA$19.99', periodUnit: 'year' as const, periodCount: 1 };
    const text = paywallTerms(os, product).join(' ');
    expect(text).toMatch(/renews automatically annually at CA\$19\.99 per year/);
    expect(text).toMatch(/cancelled at least 24 hours before the end of the current period/);
    expect(text).toContain(os === 'ios' ? 'Apple ID' : 'Google Play account');
    expect(text).toMatch(/Manage or cancel any time/);
    expect(text).toMatch(/Payment of CA\$19\.99 is charged/);
  });

  it('links to the platform subscription-management pages', () => {
    expect(manageSubscriptionsUrl('ios')).toBe('https://apps.apple.com/account/subscriptions');
    expect(manageSubscriptionsUrl('android')).toBe(
      'https://play.google.com/store/account/subscriptions?package=com.shiftlogichq.pantryrun&sku=pantryrun_plus_annual',
    );
    // The package in the deep link must be the real one.
    expect(read('app.json')).toContain('"package": "com.shiftlogichq.pantryrun"');
  });

  it('Terms of Use and Privacy Policy point at the published pages', () => {
    expect(TERMS_OF_USE_URL).toBe('https://www.pantryrun.app/terms');
    expect(PRIVACY_POLICY_URL).toBe('https://www.pantryrun.app/privacy');
  });
});

describe('every place Plus is sold goes through PlusPaywall', () => {
  const paywall = read('src/components/PlusPaywall.tsx');
  const listScreen = read('src/screens/GroceryListScreen.tsx');
  const settings = read('src/screens/SettingsScreen.tsx');

  it('the paywall carries Subscribe, Restore, terms, manage and legal links', () => {
    expect(paywall).toContain('purchasePlus()');
    expect(paywall).toContain('restorePlus()');
    expect(paywall).toContain('Restore Purchases');
    expect(paywall).toContain('paywallTerms(');
    expect(paywall).toContain('pricing.planName');
    expect(paywall).toContain('openLink(TERMS_OF_USE_URL)');
    expect(paywall).toContain('openLink(PRIVACY_POLICY_URL)');
    expect(paywall).toContain('openManageSubscriptions');
    expect(paywall).toContain('loadPlusProduct()');
    expect(paywall).toContain('pendingPayment');
  });

  it('both selling screens render PlusPaywall and never sell from an Alert', () => {
    for (const src of [listScreen, settings]) {
      expect(src).toContain("from '../components/PlusPaywall'");
      expect(src).toMatch(/<PlusPaywall\s+visible=/);
      expect(src).not.toContain('purchasePlus');
      expect(src).not.toContain('PLUS_PRICE_DISPLAY');
    }
    expect(listScreen).not.toMatch(/Alert\.alert\(\s*'PantryRun Plus'/);
  });
});
