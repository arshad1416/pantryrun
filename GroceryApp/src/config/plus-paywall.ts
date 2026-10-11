/**
 * PantryRun Plus paywall — the disclosure text and links (Apple Guideline
 * 3.1.2 / Google Play subscription policy), kept pure so it is testable and
 * so both places that sell Plus show identical terms.
 *
 * Entitlement state is NOT computed here — that is src/config/entitlements.ts
 * alone. This module only turns the store's product details into copy.
 */

import {
  PLUS_FALLBACK_PRICE,
  PLUS_PRODUCT_ID,
  type PlusProductInfo,
  type PlusPeriodUnit,
} from './entitlements';

export const TERMS_OF_USE_URL = 'https://www.pantryrun.app/terms';
export const PRIVACY_POLICY_URL = 'https://www.pantryrun.app/privacy';
/** Must match app.json android.package. */
export const ANDROID_PACKAGE_NAME = 'com.shiftlogichq.pantryrun';

export const PLUS_PLAN_FALLBACK_NAME = 'PantryRun Plus';

export interface PaywallPricing {
  planName: string;
  /** Localized price per period, e.g. "CA$19.99". */
  price: string;
  /** "year", "month", "3 months", … */
  period: string;
  /** "CA$19.99/year". */
  priceLabel: string;
  /** "annually", "monthly", "every 3 months", … */
  renews: string;
  /** false while the store has not answered: price is the fallback. */
  fromStore: boolean;
}

function periodText(unit: PlusPeriodUnit, count: number): string {
  return count === 1 ? unit : `${count} ${unit}s`;
}

function renewsText(unit: PlusPeriodUnit, count: number): string {
  if (count === 1) {
    return { day: 'daily', week: 'weekly', month: 'monthly', year: 'annually' }[unit];
  }
  return `every ${count} ${unit}s`;
}

export function paywallPricing(product: PlusProductInfo | null): PaywallPricing {
  if (!product) {
    return {
      planName: `${PLUS_PLAN_FALLBACK_NAME} — Annual`,
      price: PLUS_FALLBACK_PRICE,
      period: 'year',
      priceLabel: `${PLUS_FALLBACK_PRICE}/year`,
      renews: 'annually',
      fromStore: false,
    };
  }
  const period = periodText(product.periodUnit, product.periodCount);
  return {
    planName: product.title,
    price: product.displayPrice,
    period,
    priceLabel: `${product.displayPrice}/${period}`,
    renews: renewsText(product.periodUnit, product.periodCount),
    fromStore: true,
  };
}

export function storeAccountName(os: string): string {
  return os === 'ios' ? 'Apple ID' : 'Google Play account';
}

/** Where the buyer manages or cancels. Both are the stores' own pages. */
export function manageSubscriptionsUrl(os: string): string {
  return os === 'ios'
    ? 'https://apps.apple.com/account/subscriptions'
    : `https://play.google.com/store/account/subscriptions?package=${ANDROID_PACKAGE_NAME}&sku=${PLUS_PRODUCT_ID}`;
}

/** The auto-renewal disclosure, one paragraph per entry. */
export function paywallTerms(os: string, product: PlusProductInfo | null): string[] {
  const p = paywallPricing(product);
  const account = storeAccountName(os);
  const manage =
    os === 'ios'
      ? 'Settings › [your name] › Subscriptions'
      : 'the Play Store › Profile › Payments & subscriptions › Subscriptions';
  return [
    `Payment of ${p.price} is charged to your ${account} when you confirm the purchase.`,
    `The subscription renews automatically ${p.renews} at ${p.price} per ${p.period} ` +
      'unless it is cancelled at least 24 hours before the end of the current period. ' +
      `Your ${account} is charged for the renewal within the 24 hours before the current period ends.`,
    `Manage or cancel any time in ${manage}, or with "Manage subscription" below. ` +
      'Cancelling stops the next renewal; Plus stays active until the end of the period you have paid for.',
  ];
}
