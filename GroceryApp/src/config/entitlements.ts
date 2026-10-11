/**
 * PantryRun Plus — entitlement resolution, purchase, and restore.
 *
 * ── INVARIANT (Goal 7) ───────────────────────────────────────────────────────
 * This is the ONLY file that may compute entitlement state. No other file may
 * read a receipt, read purchase state, touch the `entitlements` table, or
 * default a gating flag. Every other file imports `useEntitlementStore` /
 * `isPlusEntitled()` from here. Scattered checks are how a paywall grows a
 * path that forgot to check — in a public repo that is the difference between
 * honest-user gating and no gating at all.
 *
 * ── Model (owner decision, 2026-07-28, GOAL_PROMPT_NOTES.md) ────────────────
 * One purchase unlocks the family: the purchasing device writes an
 * entitlement record into the family Yjs document (top-level `entitlements`
 * map, E2E-encrypted in transit like everything else in the doc) so it syncs
 * to every family device, AND into the local `entitlements` table so it
 * survives app restart — Yjs document state itself is never persisted.
 *
 * Receipt validation happens at purchase time on-device (a store purchase /
 * restore must present a receipt or purchase token before we grant).
 * Server-side validation via Apple's App Store Server API / Google's Play
 * Developer API needs owner-held credentials and is deliberately absent: the
 * repository is public, client-side gating is bypassable by building from
 * source, and honest-user monetization is the accepted stance. Do not add
 * DRM here — it costs engineering time and buys nothing against the only
 * attacker who could defeat it anyway.
 *
 * react-native-iap is imported lazily inside the purchase/restore paths so
 * that importing this module never touches native billing code (keeps Jest
 * and app boot free of the native module).
 */

import { create } from 'zustand';
import { Q } from '@nozbe/watermelondb';
import { getDatabase } from '../storage/database';
import { getDoc } from '../sync/yjs-adapter';

// ─── Product constants ───────────────────────────────────────────────────────
// Same SKU on both stores. Products are created by the owner in App Store
// Connect / Play Console (see audit-package/08 handoff); price is display-only
// here — the stores are the source of truth for what is charged.

export const PLUS_PRODUCT_ID = 'pantryrun_plus_annual';
// FALLBACK ONLY. The paywall shows the store's localized price and period
// (loadPlusProduct / describePlusProduct); these render only until the store
// answers, or if it never does.
export const PLUS_FALLBACK_PRICE = '$14.99';
export const PLUS_PRICE_DISPLAY = `${PLUS_FALLBACK_PRICE}/year`;

/**
 * Paywall copy. States precisely what the savings figure compares against:
 * trip-plan.ts computes savings as the best single-store trip minus the
 * optimized multi-stop total (one-stop baseline, floored at 0).
 */
export const PLUS_PAYWALL_COPY =
  'PantryRun Plus unlocks the Trip Optimizer: the cheapest way to split ' +
  'your list across nearby stores, with savings shown against doing the ' +
  'whole trip at the cheapest single store. One purchase unlocks your ' +
  'whole family.';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlusEntitlement {
  familyId: string;
  productId: string;
  platform: 'ios' | 'android' | 'unknown';
  transactionId: string;
  purchasedAt: number;
  /**
   * Store-reported end of the current period (iOS expirationDateIOS), ms.
   * null when the store reports none — Google Play exposes no expiry to the
   * client, only "is it still in getAvailablePurchases". Either way the
   * purchasing device re-checks the store on launch / foreground
   * (verifyEntitlementWithStore) and revokes on a definitive "not owned".
   */
  expiresAt: number | null;
  source: 'purchase' | 'restore' | 'sync';
}

export interface EntitlementState {
  /** THE gating answer. Computed only inside this module. */
  isPlus: boolean;
  record: PlusEntitlement | null;
  resolution: 'unresolved' | 'resolved';
  busy: boolean;
  lastError: string | null;
  /**
   * A Plus purchase exists but the store has not taken the money yet
   * (Google Play pending payment, iOS Ask to Buy). NOT a grant and NOT an
   * error: the paywall says "payment pending" and the app-lifetime listener
   * grants when the store later reports the purchase as completed.
   */
  pendingPayment: boolean;
  /** Store-localized product details for the paywall; null until loaded. */
  product: PlusProductInfo | null;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useEntitlementStore = create<EntitlementState>(() => ({
  isPlus: false,
  record: null,
  resolution: 'unresolved',
  busy: false,
  lastError: null,
  pendingPayment: false,
  product: null,
}));

/** Synchronous read for non-React callers. Resolve first via resolveEntitlement(). */
export function isPlusEntitled(): boolean {
  return useEntitlementStore.getState().isPlus;
}

// ─── Entitlement computation (the only place this logic exists) ──────────────

/**
 * How long past `expiresAt` a record still entitles. A renewal is only
 * learned when the purchasing device next talks to the store and re-publishes
 * the record, so a strict cutoff would lock an honest subscriber out while
 * offline (or lock out the rest of the family until the purchaser opens the
 * app). A cancelled subscription is still revoked immediately on the
 * purchaser's next online launch: the store check, not this clock, is what
 * revokes.
 */
export const EXPIRY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** The purchase was made or restored with THIS device's store account, so
 *  this device can (and must) re-verify it with the store. */
function ownedByThisStoreAccount(record: PlusEntitlement): boolean {
  return record.source === 'purchase' || record.source === 'restore';
}

/**
 * The family this device is in, as last read by refreshFamilyScope().
 * undefined until first read — nothing is enforced on a value never read.
 */
let gatingFamilyId: string | undefined;

function computeIsPlus(record: PlusEntitlement | null): boolean {
  if (!record) return false;
  if (record.productId !== PLUS_PRODUCT_ID) return false;
  if (!record.transactionId) return false;
  if (record.expiresAt !== null && record.expiresAt + EXPIRY_GRACE_MS < Date.now()) return false;
  // "One purchase unlocks the family" — THIS family. A record that reached
  // this device through the family document stops entitling once the device
  // leaves (or switches) family. The buyer's own store purchase is theirs
  // wherever they go; the store re-check governs that one.
  if (
    !ownedByThisStoreAccount(record) &&
    gatingFamilyId !== undefined &&
    record.familyId !== gatingFamilyId
  ) {
    return false;
  }
  return true;
}

/** Re-read the current family and recompute the gate against it. Runs at
 *  resolve and on foreground; call it after leaving/joining a family to apply
 *  the change immediately. */
export async function refreshFamilyScope(): Promise<void> {
  gatingFamilyId = await currentFamilyId();
  const { record, isPlus } = useEntitlementStore.getState();
  const next = computeIsPlus(record);
  if (next !== isPlus) {
    useEntitlementStore.setState({ isPlus: next });
    console.log(`[entitlements] family scope changed: ${next ? 'entitled' : 'not entitled'}`);
  }
}

// ─── Local table (restart survival) ─────────────────────────────────────────

async function loadLocalRecord(): Promise<PlusEntitlement | null> {
  const rows = await getDatabase()
    .get('entitlements')
    .query(Q.where('product_id', PLUS_PRODUCT_ID))
    .fetch();
  if (rows.length === 0) return null;
  const r = rows[0] as any;
  return {
    familyId: r.familyId,
    productId: r.productId,
    platform: r.platform,
    transactionId: r.transactionId,
    purchasedAt: r.purchasedAt,
    expiresAt: r.expiresAt ?? null,
    source: r.source,
  };
}

/**
 * Upsert the local entitlement record. Single flat database.write — real
 * WatermelonDB deadlocks on nested write() even though the Jest mock permits
 * it, so no caller of this function may already hold a writer.
 */
async function persistLocalRecord(record: PlusEntitlement): Promise<void> {
  const collection = getDatabase().get('entitlements');
  const existing = await collection
    .query(Q.where('product_id', record.productId))
    .fetch();
  await getDatabase().write(async () => {
    if (existing.length > 0) {
      await existing[0].update((row: any) => {
        row.familyId = record.familyId;
        row.platform = record.platform;
        row.transactionId = record.transactionId;
        row.purchasedAt = record.purchasedAt;
        row.expiresAt = record.expiresAt;
        row.source = record.source;
        row.updatedAt = Date.now();
      });
    } else {
      await collection.create((row: any) => {
        row.familyId = record.familyId;
        row.productId = record.productId;
        row.platform = record.platform;
        row.transactionId = record.transactionId;
        row.purchasedAt = record.purchasedAt;
        row.expiresAt = record.expiresAt;
        row.source = record.source;
        row.updatedAt = Date.now();
      });
    }
  });
}

/** Remove the local entitlement row (revocation). Single flat write. */
async function deleteLocalRecord(): Promise<void> {
  const rows = await getDatabase()
    .get('entitlements')
    .query(Q.where('product_id', PLUS_PRODUCT_ID))
    .fetch();
  if (rows.length === 0) return;
  await getDatabase().write(async () => {
    for (const row of rows as any[]) {
      // destroyPermanently: the table is local-only, nothing syncs deletions.
      if (typeof row.destroyPermanently === 'function') await row.destroyPermanently();
      else await row.markAsDeleted();
    }
  });
}

// ─── Family Yjs document (cross-device sync) ─────────────────────────────────

const FAMILY_DOC_ID = '__family__';

function writeRecordToFamilyDoc(record: PlusEntitlement, revokedAt: number | null = null): void {
  const doc = getDoc(FAMILY_DOC_ID);
  doc.transact(() => {
    doc.getMap('entitlements').set(PLUS_PRODUCT_ID, {
      familyId: record.familyId,
      productId: record.productId,
      platform: record.platform,
      transactionId: record.transactionId,
      purchasedAt: record.purchasedAt,
      expiresAt: record.expiresAt,
      // A tombstone, not a delete: a family device that comes online later
      // gets the whole document via Y.applyUpdate, and a value it can read is
      // reliable where an already-applied deletion fires no observer event.
      revokedAt,
    });
  });
}

/** Make sure the family doc's update observer is sending, so a grant or
 *  revocation reaches the rest of the family. Dynamic import: useSyncStore
 *  already imports syncManager statically, a static back-import here would
 *  cycle. */
async function publishFamilyDoc(): Promise<void> {
  try {
    const { syncManager } = await import('../sync/sync-manager');
    syncManager.registerList(FAMILY_DOC_ID);
  } catch (err) {
    console.warn('[entitlements] family doc sync registration failed:', err);
  }
}

let familyDocObserverInstalled = false;

/**
 * Watch the family doc's entitlements map so a purchase made on another
 * family device (applied whole-document via Y.applyUpdate in sync-manager)
 * lands here: persisted locally with source 'sync', then resolved. A
 * revocation tombstone from the purchasing device removes a synced record.
 */
function installFamilyDocObserver(): void {
  if (familyDocObserverInstalled) return;
  familyDocObserverInstalled = true;
  const map = getDoc(FAMILY_DOC_ID).getMap('entitlements');
  const apply = () => {
    const raw = map.get(PLUS_PRODUCT_ID) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') return;
    const current = useEntitlementStore.getState().record;
    // This device's own store purchase is verified against the store, never
    // overridden (or revoked) by what another device published.
    if (current && ownedByThisStoreAccount(current) && computeIsPlus(current)) return;
    if (raw.revokedAt != null) {
      if (current && current.source === 'sync') {
        void revokeEntitlement('revoked by the purchasing family device', false);
      }
      return;
    }
    const synced: PlusEntitlement = {
      familyId: String(raw.familyId ?? ''),
      productId: String(raw.productId ?? ''),
      platform: (raw.platform as PlusEntitlement['platform']) ?? 'unknown',
      transactionId: String(raw.transactionId ?? ''),
      purchasedAt: Number(raw.purchasedAt ?? 0),
      expiresAt: raw.expiresAt == null ? null : Number(raw.expiresAt),
      source: 'sync',
    };
    if (!computeIsPlus(synced)) return;
    if (
      current &&
      current.transactionId === synced.transactionId &&
      current.expiresAt === synced.expiresAt
    ) {
      return;
    }
    persistLocalRecord(synced)
      .then(() => {
        useEntitlementStore.setState({ isPlus: true, record: synced, resolution: 'resolved' });
        console.log('[entitlements] resolved: entitled (synced from family document)');
      })
      .catch((err) => {
        // Still entitled in-memory this session; local persistence retries
        // on the next sync or resolve.
        useEntitlementStore.setState({ isPlus: true, record: synced, resolution: 'resolved' });
        console.warn('[entitlements] synced entitlement not persisted locally:', err);
      });
  };
  map.observe(apply);
  apply(); // a record may already be present from an earlier applied update
}

// ─── Resolution (app start / after purchase) ─────────────────────────────────

/**
 * Resolve entitlement from the local table, then keep listening on the
 * family document for grants made by other family devices.
 * Call once during app init, after the database is available.
 */
export async function resolveEntitlement(): Promise<boolean> {
  gatingFamilyId = await currentFamilyId();
  let record: PlusEntitlement | null = null;
  try {
    record = await loadLocalRecord();
  } catch (err) {
    console.warn('[entitlements] local record load failed:', err);
  }
  const isPlus = computeIsPlus(record);
  useEntitlementStore.setState({ isPlus, record, resolution: 'resolved' });
  console.log(
    `[entitlements] resolved: ${isPlus ? 'entitled' : 'not entitled'}` +
      ` (${record ? `local record, source=${record.source}` : 'no local record'})`,
  );
  installFamilyDocObserver();
  return isPlus;
}

// ─── Grant / revoke paths (shared by purchase / restore / sync / re-check) ───

async function grantEntitlement(record: PlusEntitlement): Promise<void> {
  await persistLocalRecord(record);
  writeRecordToFamilyDoc(record);
  await publishFamilyDoc();
  useEntitlementStore.setState({ isPlus: computeIsPlus(record), record, resolution: 'resolved' });
  console.log(`[entitlements] granted via ${record.source} (tx ${record.transactionId})`);
}

/**
 * Drop the entitlement on this device. `broadcast` (purchasing device only)
 * also publishes a tombstone so the rest of the family drops the synced copy.
 */
async function revokeEntitlement(reason: string, broadcast: boolean): Promise<void> {
  const record = useEntitlementStore.getState().record;
  useEntitlementStore.setState({ isPlus: false, record: null, resolution: 'resolved' });
  try {
    await deleteLocalRecord();
  } catch (err) {
    console.warn('[entitlements] local record delete failed:', err);
  }
  if (broadcast && record) {
    writeRecordToFamilyDoc(record, Date.now());
    await publishFamilyDoc();
  }
  console.log(`[entitlements] revoked: ${reason}`);
}

async function currentFamilyId(): Promise<string> {
  try {
    const { getFamilyMembership } = await import('../identity/family');
    const membership = await getFamilyMembership();
    if (membership?.familyId) return membership.familyId;
  } catch {
    // fall through — solo devices can still hold an entitlement
  }
  return 'local';
}

// ─── Purchase / restore (react-native-iap v15, lazily loaded) ──────────────
// v15 is event-based: requestPurchase() dispatches the flow and the result
// arrives through purchaseUpdatedListener / purchaseErrorListener.

// The subset of react-native-iap 15's `Purchase` (types.ts PurchaseCommon /
// PurchaseIOS / PurchaseAndroid) that this module reads. Every field is
// optional here because events and restores arrive from the native bridge and
// we would rather refuse a grant than crash on a missing field.
type IapPurchase = {
  productId?: string;
  ids?: string[] | null;
  transactionId?: string | null;
  /** Unified purchase token (iOS JWS, Android purchaseToken). */
  purchaseToken?: string | null;
  transactionDate?: number;
  /** 'pending' | 'purchased' | 'unknown'. Only 'purchased' may grant. */
  purchaseState?: 'pending' | 'purchased' | 'unknown' | string;
  /** Android: false until finishTransaction acknowledges it. Play refunds
   *  unacknowledged purchases after ~3 days. */
  isAcknowledgedAndroid?: boolean | null;
  /** Android (Billing 8.1+): payment failed; must not entitle. */
  isSuspendedAndroid?: boolean | null;
  /** iOS: subscription expiry, ms since epoch. */
  expirationDateIOS?: number | null;
  /** iOS: set when Apple refunded/revoked the transaction. */
  revocationDateIOS?: number | null;
};

/** How a purchase event or restore settled, for the caller that started it. */
export type PurchaseOutcome = 'granted' | 'pending';

function receiptPresent(p: IapPurchase): boolean {
  // Purchase-time receipt check: a store purchase must carry a signed store
  // token (iOS JWS / Android purchase token) before we grant.
  return Boolean(p.purchaseToken || p.transactionId);
}

async function purchaseToRecord(
  p: IapPurchase,
  source: PlusEntitlement['source'],
): Promise<PlusEntitlement> {
  const { Platform } = await import('react-native');
  return {
    familyId: await currentFamilyId(),
    productId: p.productId ?? PLUS_PRODUCT_ID,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    transactionId: p.transactionId ?? p.purchaseToken ?? `tx-${Date.now()}`,
    purchasedAt: p.transactionDate ?? Date.now(),
    // iOS reports the period end; Google Play reports none to the client
    // (validity there is "still returned by getAvailablePurchases").
    expiresAt:
      typeof p.expirationDateIOS === 'number' && p.expirationDateIOS > 0
        ? p.expirationDateIOS
        : null,
    source,
  };
}

/** One Google Play subscription offer, as `requestPurchase` wants it. */
export type GoogleSubscriptionOffer = { sku: string; offerToken: string };

/**
 * The base plan the paywall price refers to.
 *
 * The paywall shows this plan's store price (describePlusProduct reads the
 * same bare base-plan offer), so whatever we buy MUST be this plan. Play returns one entry per
 * OFFER, not per base plan — add a free trial or intro offer in the Console and
 * the array grows without any repo change. Taking whatever came first would let
 * store ordering decide what the user is charged while the button still
 * advertises the standard price.
 */
export const PLUS_BASE_PLAN_ID = 'annual';

/** Raised when the store cannot sell the subscription. `userMessage` is the
 *  only part safe to show a buyer; `message` carries the operator detail. */
export class PurchaseUnavailableError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = 'PurchaseUnavailableError';
  }
}

/**
 * Look up the Play offer token for PLUS_PRODUCT_ID's base plan.
 *
 * Returns `undefined` on iOS, where `subscriptionOffers` is ignored.
 *
 * Every failure mode is reported separately because each needs a different
 * fix and all of them are invisible from the app side otherwise:
 *
 *   lookup failed     fetchProducts returned null. Usually the network or a
 *                     dead Billing connection, NOT a Console problem.
 *   product missing   the subscription does not exist, is not active, or the
 *                     Play merchant account is not set up. This is what the
 *                     store surfaces to users as "SKU not found".
 *   no offers         Play has the product but will sell this account nothing,
 *                     usually region or eligibility rules.
 *   plan unsellable   the base plan we price is missing, in draft, or came
 *                     back with an empty token.
 *
 * Each error carries a separate `userMessage`; the operator detail above is
 * for the log, since `lastError` is rendered straight into an Alert.
 *
 * Exported for testing; `purchasePlus` is the only production caller.
 */
export async function resolveAndroidOffers(
  iap: {
    fetchProducts: (opts: { skus: string[]; type: 'subs' }) => Promise<unknown>;
  },
  platformOverride?: string,
): Promise<GoogleSubscriptionOffer[] | undefined> {
  const os = platformOverride ?? (await import('react-native')).Platform.OS;
  if (os !== 'android') return undefined;

  let raw: unknown;
  try {
    raw = await iap.fetchProducts({ skus: [PLUS_PRODUCT_ID], type: 'subs' });
  } catch (e: any) {
    // A failed lookup does NOT come back as a value — every failure path in
    // fetchProducts rethrows createPurchaseError carrying the raw native
    // message (react-native-iap src/index.ts:955-974). Uncaught, that message
    // lands verbatim in the buyer's Alert. This call is new to the purchase
    // path, so without this catch the leak would be new too: airplane mode, or
    // a device not signed into Play, would show a native billing string.
    throw new PurchaseUnavailableError(
      `fetchProducts threw: ${e?.message ?? String(e)}`,
      'Could not reach the store. Check your connection and try again.',
    );
  }

  // The declared return type is `… | null` (types.d.ts:561) even though every
  // current success path returns an array. Cheap to honour the contract.
  if (raw == null) {
    throw new PurchaseUnavailableError(
      'fetchProducts returned null — the store lookup did not complete.',
      'Could not reach the store. Check your connection and try again.',
    );
  }

  const products = (Array.isArray(raw) ? raw : []) as Array<{
    id?: string;
    productStatusAndroid?: 'ok' | 'not-found' | 'no-offers-available' | 'unknown' | null;
    subscriptionOfferDetailsAndroid?: Array<{
      basePlanId?: string;
      offerId?: string | null;
      offerToken?: string | null;
    }> | null;
  }>;

  const product = products.find((p) => p.id === PLUS_PRODUCT_ID);

  // Handle BOTH shapes, because which one Android produces is not pinned down
  // by anything in this tree: the product may be absent from the array, or
  // present as a placeholder carrying productStatusAndroid 'not-found' (the
  // status is optional AND nullable — type-bridge.ts:373, types.d.ts:1163).
  // An earlier version tested only `!product`, so if the placeholder shape is
  // the real one, a nonexistent subscription fell through and reported
  // "activate a base plan" — pointing the operator at the wrong screen.
  // Checking both costs one comparison and cannot be wrong either way.
  const status = product?.productStatusAndroid ?? undefined;

  if (!product || status === 'not-found') {
    throw new PurchaseUnavailableError(
      `Subscription "${PLUS_PRODUCT_ID}" does not exist in the store. It must be ` +
        'created AND active in Play Console — which itself requires a Google ' +
        'Payments merchant account — and the app must be installed from Play ' +
        'rather than sideloaded.',
      'This subscription is not available yet. Please try again later.',
    );
  }

  if (status === 'no-offers-available') {
    throw new PurchaseUnavailableError(
      `Subscription "${PLUS_PRODUCT_ID}" exists but Play reports no offers ` +
        'available to this account — usually region or eligibility rules.',
      'This subscription is not available on your account.',
    );
  }

  const rawOffers = product.subscriptionOfferDetailsAndroid ?? [];
  const offers = rawOffers.filter(
    (o): o is { basePlanId?: string; offerId?: string | null; offerToken: string } =>
      typeof o?.offerToken === 'string' && o.offerToken.length > 0,
  );

  // Pick the plan the paywall priced, and within it ONLY the bare base plan, so
  // the charge matches the price on the paywall's Subscribe button.
  //
  // There is deliberately no `?? forPlan[0]` fallback. Falling back to the
  // first entry is precisely the store-ordering dependence this function
  // exists to remove — a Console-side edit alone can reorder the array, and a
  // promotional offer selected that way bills a price the button never showed.
  // Refusing to guess turns that into a loud, diagnosable failure instead.
  //
  // Play returns one entry per (base plan, offer) pair plus one for the bare
  // base plan itself, so an active base plan always yields a match. `''` counts
  // as absent alongside null/undefined: the field's spelling at the native
  // boundary is not pinned by the .d.ts, and an empty string here would
  // otherwise make every purchase fail.
  const forPlan = offers.filter((o) => o.basePlanId === PLUS_BASE_PLAN_ID);
  const chosen = forPlan.find((o) => o.offerId == null || o.offerId === '');

  if (!chosen) {
    // Report from rawOffers, not the filtered list. An offer dropped for an
    // empty token would otherwise vanish from the diagnostic and read as "no
    // such plan" — erasing the fingerprint of this exact bug arriving from the
    // store side instead of from our source.
    const dropped = rawOffers.length - offers.length;
    const plans = [...new Set(rawOffers.map((o) => o?.basePlanId ?? '?'))].join(', ');
    throw new PurchaseUnavailableError(
      `Subscription "${PLUS_PRODUCT_ID}" has no bare base-plan offer for ` +
        `"${PLUS_BASE_PLAN_ID}" (store returned ${rawOffers.length} offer(s) for ` +
        `plans: ${plans || 'none'}` +
        (dropped > 0 ? `; ${dropped} dropped for an empty offerToken` : '') +
        (forPlan.length > 0
          ? `; ${forPlan.length} matched the plan but all carried an offerId, ` +
            'so charging one would not match the advertised price'
          : '') +
        `). Check that base plan "${PLUS_BASE_PLAN_ID}" exists and is ACTIVE in ` +
        'Play Console — the ID must match exactly.',
      'This subscription is not available right now. Please try again later.',
    );
  }

  return [{ sku: PLUS_PRODUCT_ID, offerToken: chosen.offerToken }];
}

// ─── Store product details (paywall price and period) ─────────────────────────
// Apple Guideline 3.1.2 requires the paywall to show the price and billing
// period the store will actually charge, in the buyer's currency. That is
// only knowable from the store, so the paywall renders from this and treats
// PLUS_PRICE_DISPLAY as a placeholder while it loads.

export type PlusPeriodUnit = 'day' | 'week' | 'month' | 'year';

export interface PlusProductInfo {
  /** Store display name of the subscription. */
  title: string;
  /** Localized price per period, e.g. "CA$19.99". */
  displayPrice: string;
  periodUnit: PlusPeriodUnit;
  periodCount: number;
}

/** Parse a Play ISO-8601 billing period ("P1Y", "P6M", "P1W", "P7D"). */
export function parseBillingPeriod(
  iso: string | null | undefined,
): { unit: PlusPeriodUnit; count: number } | null {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(iso ?? '');
  if (!m) return null;
  const parts: Array<[PlusPeriodUnit, string | undefined]> = [
    ['year', m[1]],
    ['month', m[2]],
    ['week', m[3]],
    ['day', m[4]],
  ];
  const set = parts.filter(([, v]) => v !== undefined && Number(v) > 0);
  if (set.length !== 1) return null; // mixed periods: do not guess
  return { unit: set[0][0], count: Number(set[0][1]) };
}

/**
 * Turn a fetchProducts({ type: 'subs' }) answer into what the paywall shows.
 * Pure; exported for testing. Returns null when the answer does not carry a
 * price AND period for the plan we sell — the caller then keeps the fallback.
 *
 * Android reads the bare `PLUS_BASE_PLAN_ID` offer's recurring phase, the
 * same plan resolveAndroidOffers buys, so the price shown is the price
 * charged (ProductCommon.displayPrice on Android may describe another offer).
 */
export function describePlusProduct(raw: unknown, os: string): PlusProductInfo | null {
  if (!Array.isArray(raw)) return null;
  const p = (raw as any[]).find((x) => x?.id === PLUS_PRODUCT_ID);
  if (!p) return null;
  const title =
    (typeof p.displayName === 'string' && p.displayName) ||
    (typeof p.displayNameIOS === 'string' && p.displayNameIOS) ||
    (typeof p.nameAndroid === 'string' && p.nameAndroid) ||
    (typeof p.title === 'string' && p.title) ||
    'PantryRun Plus';

  if (os === 'ios') {
    const unit = p.subscriptionPeriodUnitIOS as string | null | undefined;
    const count = Number(p.subscriptionPeriodNumberIOS ?? 1);
    if (
      typeof p.displayPrice !== 'string' ||
      !p.displayPrice ||
      !(unit === 'day' || unit === 'week' || unit === 'month' || unit === 'year') ||
      !(count > 0)
    ) {
      return null;
    }
    return { title, displayPrice: p.displayPrice, periodUnit: unit, periodCount: count };
  }

  const offers: any[] = Array.isArray(p.subscriptionOfferDetailsAndroid)
    ? p.subscriptionOfferDetailsAndroid
    : [];
  const base = offers.find(
    (o) => o?.basePlanId === PLUS_BASE_PLAN_ID && (o?.offerId == null || o?.offerId === ''),
  );
  const phases: any[] = base?.pricingPhases?.pricingPhaseList ?? [];
  // The recurring phase (recurrenceMode 1 = INFINITE_RECURRING) is the
  // renewal price; a bare base plan normally has exactly that one phase.
  const phase = phases.find((ph) => ph?.recurrenceMode === 1) ?? phases[phases.length - 1];
  const period = parseBillingPeriod(phase?.billingPeriod);
  if (!phase || typeof phase.formattedPrice !== 'string' || !phase.formattedPrice || !period) {
    return null;
  }
  return { title, displayPrice: phase.formattedPrice, periodUnit: period.unit, periodCount: period.count };
}

/**
 * Fetch the localized product for the paywall into the store. Never throws;
 * on any failure the paywall keeps showing the fallback price.
 */
export async function loadPlusProduct(): Promise<PlusProductInfo | null> {
  try {
    const iap = await import('react-native-iap');
    await iap.initConnection();
    const raw = await iap.fetchProducts({ skus: [PLUS_PRODUCT_ID], type: 'subs' });
    const { Platform } = await import('react-native');
    const info = describePlusProduct(raw, Platform.OS);
    if (info) useEntitlementStore.setState({ product: info });
    return info;
  } catch (err: any) {
    console.warn('[entitlements] product lookup failed (showing fallback price):', err?.message ?? err);
    return null;
  }
}

// ─── App-lifetime purchase listener ──────────────────────────────────────────
// Store events are NOT tied to the purchase sheet. A Play "pending" payment
// (cash at a kiosk, bank transfer) completes hours later; an iOS Ask to Buy
// approval arrives whenever the parent taps Approve; an unfinished StoreKit
// transaction is re-delivered on the next launch. If listeners exist only
// while purchasePlus() is awaiting, all of those land with nobody listening:
// the buyer is charged, never unlocked, and — on Android — never acknowledged,
// so Play auto-refunds after ~3 days. So the listeners are installed once, for
// the life of the app, and every Plus event goes through handlePurchaseUpdate.

type IapListenerApi = {
  purchaseUpdatedListener: (fn: (p: any) => void) => { remove: () => void };
  purchaseErrorListener: (fn: (e: any) => void) => { remove: () => void };
  finishTransaction: (args: { purchase: any; isConsumable?: boolean }) => Promise<unknown>;
};

/** The purchasePlus() call currently waiting on the store, if any. */
let purchaseWaiter: {
  resolve: (outcome: PurchaseOutcome) => void;
  reject: (err: Error) => void;
} | null = null;

let purchaseListenersInstalled = false;

// Store events emitted while no JS listener was attached are buffered
// natively and flushed to the first listener that attaches, so an event is
// not necessarily the one just requested.
//
// The predicate is deliberately asymmetric: skip only events that name a
// DIFFERENT product. An event carrying no identity at all is attributed to an
// in-flight purchasePlus() — PurchaseError.productId is optional and nullable
// (types.ts PurchaseError), which is precisely the shape a user cancellation
// arrives in, and ignoring it would leave `busy: true` stuck forever.
function eventProductIds(x: any): string[] {
  return [x?.productId, ...(x?.ids ?? []), ...(x?.productIds ?? [])].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
}
function isSomeoneElses(x: any): boolean {
  const n = eventProductIds(x);
  return n.length > 0 && !n.includes(PLUS_PRODUCT_ID);
}

function settleWaiter(outcome: PurchaseOutcome): void {
  const w = purchaseWaiter;
  purchaseWaiter = null;
  w?.resolve(outcome);
}
function failWaiter(err: Error): void {
  const w = purchaseWaiter;
  purchaseWaiter = null;
  w?.reject(err);
}

/** Acknowledge (Android) / finish (iOS) a completed purchase. A failure is
 *  logged, not fatal: the buyer has paid, so they are still granted, and the
 *  launch-time store check retries any purchase still unacknowledged. */
async function finishPurchase(
  iap: Pick<IapListenerApi, 'finishTransaction'>,
  p: IapPurchase,
): Promise<void> {
  try {
    await iap.finishTransaction({ purchase: p as any, isConsumable: false });
  } catch (err) {
    console.warn('[entitlements] finishTransaction failed (retried on next launch):', err);
  }
}

/**
 * Handle one purchaseUpdatedListener event. Grants ONLY on purchaseState
 * 'purchased'; 'pending' is reported as payment pending (no grant, no error,
 * nothing finished — Play cannot acknowledge a pending purchase).
 *
 * Exported for testing; the app-lifetime listener is the production caller.
 */
export async function handlePurchaseUpdate(
  iap: Pick<IapListenerApi, 'finishTransaction'>,
  p: IapPurchase,
): Promise<PurchaseOutcome | 'ignored'> {
  if (isSomeoneElses(p)) return 'ignored';
  // An identity-less event with nobody waiting cannot be attributed to Plus.
  if (eventProductIds(p).length === 0 && !purchaseWaiter) return 'ignored';
  try {
    if (p.purchaseState === 'pending') {
      useEntitlementStore.setState({ pendingPayment: true });
      console.log('[entitlements] Plus purchase is pending payment — not granted yet');
      settleWaiter('pending');
      return 'pending';
    }
    if (p.purchaseState !== 'purchased') {
      console.warn(`[entitlements] Plus purchase in state "${p.purchaseState}" — not granting`);
      failWaiter(new Error('The store could not confirm this purchase yet. Please try again shortly.'));
      return 'ignored';
    }
    if (!receiptPresent(p)) {
      failWaiter(new Error('Purchase did not return a store receipt — not granting.'));
      return 'ignored';
    }
    await finishPurchase(iap, p);
    await grantEntitlement(await purchaseToRecord(p, 'purchase'));
    useEntitlementStore.setState({ pendingPayment: false });
    settleWaiter('granted');
    return 'granted';
  } catch (err: any) {
    console.warn('[entitlements] purchase update handling failed:', err?.message ?? err);
    failWaiter(err instanceof Error ? err : new Error(String(err)));
    return 'ignored';
  }
}

/** Handle one purchaseErrorListener event. Exported for testing. */
export function handlePurchaseError(e: any): void {
  if (isSomeoneElses(e)) return;
  // iOS Ask to Buy / deferred payments surface as an error code, but they are
  // the iOS twin of Play's pending state: not a failure, not a grant.
  if (e?.code === 'deferred-payment' || e?.code === 'pending') {
    useEntitlementStore.setState({ pendingPayment: true });
    settleWaiter('pending');
    return;
  }
  if (!purchaseWaiter) {
    console.warn('[entitlements] store error with no purchase in flight:', e?.message ?? e?.code);
    return;
  }
  const err = new Error(e?.message ?? e?.code ?? 'purchase failed') as Error & { code?: string };
  err.code = e?.code;
  failWaiter(err);
}

/** Install the app-lifetime purchase listeners. Idempotent. */
function ensurePurchaseListeners(iap: IapListenerApi): void {
  if (purchaseListenersInstalled) return;
  purchaseListenersInstalled = true;
  iap.purchaseUpdatedListener((p: any) => {
    void handlePurchaseUpdate(iap, p as IapPurchase);
  });
  iap.purchaseErrorListener((e: any) => handlePurchaseError(e));
}

// ─── Store verdict (restore / launch re-check) ────────────────────────────────

export type StoreVerdict =
  | { kind: 'active'; purchase: IapPurchase }
  /** The store has a Plus purchase awaiting payment, and no completed one. */
  | { kind: 'pending' }
  /** The store answered and this account owns no active Plus. */
  | { kind: 'none' }
  /** The answer is not trustworthy enough to act on. Never revoke on this. */
  | { kind: 'unknown'; reason: string };

/**
 * Classify a getAvailablePurchases() result for Plus. Pure; exported for
 * testing. Only a well-formed array with no Plus purchase in it is 'none' —
 * anything ambiguous is 'unknown', because 'none' is what revokes.
 */
export function classifyStorePurchases(raw: unknown, now: number = Date.now()): StoreVerdict {
  if (!Array.isArray(raw)) return { kind: 'unknown', reason: 'store returned a non-array' };
  const plus = (raw as IapPurchase[]).filter((p) => p?.productId === PLUS_PRODUCT_ID);
  const active = plus
    .filter(
      (p) =>
        p.purchaseState === 'purchased' &&
        receiptPresent(p) &&
        p.isSuspendedAndroid !== true &&
        p.revocationDateIOS == null &&
        !(typeof p.expirationDateIOS === 'number' && p.expirationDateIOS < now),
    )
    .sort(
      (a, b) =>
        (b.expirationDateIOS ?? b.transactionDate ?? 0) -
        (a.expirationDateIOS ?? a.transactionDate ?? 0),
    );
  if (active.length > 0) return { kind: 'active', purchase: active[0] };
  if (plus.some((p) => p.purchaseState === 'pending')) return { kind: 'pending' };
  // A Plus entry in a state we cannot read is not proof of absence.
  if (plus.some((p) => p.purchaseState !== 'purchased')) {
    return { kind: 'unknown', reason: 'Plus purchase in an unrecognised state' };
  }
  return { kind: 'none' };
}

// ─── Purchase / restore ───────────────────────────────────────────────────────

/**
 * Buy PantryRun Plus on this device's store account, then unlock the family.
 * Returns true when the entitlement was granted. A pending payment returns
 * false with `pendingPayment: true` and no `lastError`.
 */
export async function purchasePlus(): Promise<boolean> {
  useEntitlementStore.setState({ busy: true, lastError: null });
  try {
    const iap = await import('react-native-iap');
    await iap.initConnection();
    ensurePurchaseListeners(iap as unknown as IapListenerApi);

    // Google Play Billing v5+ requires a REAL offer token, obtained from the
    // store for the specific base plan being bought. This used to pass the
    // empty string with a comment claiming Play would resolve the offer in its
    // own UI — it does not; Billing rejects the request. The token is only
    // knowable at runtime (Play mints it per product/base-plan), so it has to
    // be fetched immediately before the purchase rather than hardcoded.
    //
    // iOS ignores subscriptionOffers entirely and keys off `apple.sku`.
    const googleOffers = await resolveAndroidOffers(iap);

    // The result arrives through the app-lifetime listener, which finishes /
    // acknowledges and grants; this call only waits for it to settle.
    const outcome = await new Promise<PurchaseOutcome>((resolve, reject) => {
      purchaseWaiter = { resolve, reject };
      iap
        .requestPurchase({
          request: {
            apple: { sku: PLUS_PRODUCT_ID },
            google: {
              skus: [PLUS_PRODUCT_ID],
              subscriptionOffers: googleOffers,
            },
          },
          type: 'subs',
        })
        .catch((e: unknown) => {
          if (purchaseWaiter?.resolve === resolve) purchaseWaiter = null;
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    });

    return outcome === 'granted';
  } catch (err: any) {
    const message = err?.message ?? String(err);
    // User cancellation is not an error state worth surfacing loudly.
    const cancelled = err?.code === 'user-cancelled' || /cancel/i.test(message);
    // `lastError` is rendered straight into Alert.alert('Purchase failed', …) by
    // the paywall, so it has to read as something a buyer can act on.
    // Store-configuration failures carry a separate userMessage; the operator
    // detail stays in the log, where it is actually useful. Telling a customer
    // to "activate a base plan in Play Console" is a support ticket, not an
    // error message.
    const shown =
      err instanceof PurchaseUnavailableError ? err.userMessage : message;
    useEntitlementStore.setState({ lastError: cancelled ? null : shown });
    if (!cancelled) console.warn('[entitlements] purchase failed:', message);
    return false;
  } finally {
    useEntitlementStore.setState({ busy: false });
  }
}

/**
 * Restore a previous purchase from this device's store account
 * (fresh install / new device on the same Apple ID or Google account).
 */
export async function restorePlus(): Promise<boolean> {
  useEntitlementStore.setState({ busy: true, lastError: null });
  try {
    const iap = await import('react-native-iap');
    await iap.initConnection();
    const verdict = classifyStorePurchases(await iap.getAvailablePurchases());
    if (verdict.kind === 'pending') {
      useEntitlementStore.setState({ pendingPayment: true });
      return false;
    }
    if (verdict.kind !== 'active') {
      useEntitlementStore.setState({ lastError: 'No previous purchase found on this store account.' });
      return false;
    }
    // A purchase made while the app was not listening (or whose ack failed)
    // is still unacknowledged; acknowledge before granting or Play refunds it.
    if (verdict.purchase.isAcknowledgedAndroid === false) {
      await finishPurchase(iap as unknown as IapListenerApi, verdict.purchase);
    }
    await grantEntitlement(await purchaseToRecord(verdict.purchase, 'restore'));
    useEntitlementStore.setState({ pendingPayment: false });
    return true;
  } catch (err: any) {
    const message = err?.message ?? String(err);
    // Same modal, same rule as purchasePlus: the buyer gets the actionable
    // half, the operator detail goes to the log.
    const shown =
      err instanceof PurchaseUnavailableError
        ? err.userMessage
        : 'Could not reach the store. Check your connection and try again.';
    useEntitlementStore.setState({ lastError: shown });
    console.warn('[entitlements] restore failed:', message);
    return false;
  } finally {
    useEntitlementStore.setState({ busy: false });
  }
}

// ─── Store re-check (app launch / foreground) ──────────────────────────────────
// A subscription can lapse, be cancelled, or be refunded long after the grant.
// The purchasing device re-asks its own store account and revokes ONLY on a
// definitive "this account owns no active Plus". Offline, a store error, a
// malformed answer, or a pending payment changes nothing: an honest
// subscriber must never lose Plus because the network was down.

let verifyInFlight: Promise<StoreVerdict['kind']> | null = null;
let lastVerifiedAt = 0;
/** Foreground re-checks closer together than this are skipped. */
const REVERIFY_MIN_INTERVAL_MS = 5 * 60 * 1000;

async function runStoreVerification(): Promise<StoreVerdict['kind']> {
  let verdict: StoreVerdict;
  let iap: typeof import('react-native-iap');
  try {
    iap = await import('react-native-iap');
    await iap.initConnection();
    verdict = classifyStorePurchases(await iap.getAvailablePurchases());
  } catch (err: any) {
    console.warn('[entitlements] store re-check failed (no change):', err?.message ?? err);
    return 'unknown';
  }
  lastVerifiedAt = Date.now();

  const { Platform } = await import('react-native');
  const record = useEntitlementStore.getState().record;

  switch (verdict.kind) {
    case 'active': {
      const p = verdict.purchase;
      if (p.isAcknowledgedAndroid === false) {
        await finishPurchase(iap as unknown as IapListenerApi, p);
      }
      const fresh = await purchaseToRecord(
        p,
        record && ownedByThisStoreAccount(record) ? record.source : 'restore',
      );
      // Re-publish only when something changed (renewal, new transaction,
      // family moved, or nothing held yet): each write is a sync round.
      const changed =
        !record ||
        !ownedByThisStoreAccount(record) ||
        record.transactionId !== fresh.transactionId ||
        record.expiresAt !== fresh.expiresAt ||
        record.familyId !== fresh.familyId;
      if (changed) await grantEntitlement(fresh);
      useEntitlementStore.setState({ pendingPayment: false });
      break;
    }
    case 'pending':
      useEntitlementStore.setState({ pendingPayment: true });
      break;
    case 'none':
      useEntitlementStore.setState({ pendingPayment: false });
      // Only a record this device's store account owns, on this store.
      // A family-synced record is the purchaser's to revoke, not ours.
      if (
        record &&
        ownedByThisStoreAccount(record) &&
        record.platform === (Platform.OS === 'ios' ? 'ios' : 'android')
      ) {
        await revokeEntitlement('store reports no active subscription', true);
      }
      break;
    case 'unknown':
      console.warn(`[entitlements] store re-check inconclusive (no change): ${verdict.reason}`);
      break;
  }
  return verdict.kind;
}

/**
 * Re-verify the entitlement with this device's store account. Never throws.
 * Skipped while a purchase/restore is in flight (its own sheet makes the
 * store answer transiently incomplete).
 */
export async function verifyEntitlementWithStore(): Promise<StoreVerdict['kind']> {
  if (useEntitlementStore.getState().busy || purchaseWaiter) return 'unknown';
  if (!verifyInFlight) {
    verifyInFlight = runStoreVerification()
      .catch((err) => {
        console.warn('[entitlements] store re-check aborted (no change):', err);
        return 'unknown' as const;
      })
      .finally(() => {
        verifyInFlight = null;
      });
  }
  return verifyInFlight;
}

let lifecycleStarted = false;

/**
 * App-lifetime store wiring. Call once after resolveEntitlement() during
 * app init; does not need to be awaited and never throws.
 *   - installs the purchase listeners (pending payments that complete later,
 *     iOS transactions re-delivered at launch),
 *   - re-checks the subscription with the store now and whenever the app
 *     returns from the background.
 */
export async function startEntitlementLifecycle(): Promise<void> {
  if (lifecycleStarted) return;
  lifecycleStarted = true;
  try {
    const iap = await import('react-native-iap');
    await iap.initConnection();
    ensurePurchaseListeners(iap as unknown as IapListenerApi);
  } catch (err: any) {
    console.warn('[entitlements] store connection unavailable at launch:', err?.message ?? err);
  }
  await verifyEntitlementWithStore();
  // Warm the localized price so upsell buttons show it, not the fallback.
  if (!useEntitlementStore.getState().isPlus) void loadPlusProduct();
  try {
    const { AppState } = await import('react-native');
    let previous = AppState.currentState;
    AppState.addEventListener('change', (next) => {
      const cameBack = previous === 'background' && next === 'active';
      previous = next;
      if (!cameBack) return;
      void refreshFamilyScope().catch(() => {});
      if (Date.now() - lastVerifiedAt >= REVERIFY_MIN_INTERVAL_MS) {
        void verifyEntitlementWithStore();
      }
    });
  } catch (err) {
    console.warn('[entitlements] foreground re-check not installed:', err);
  }
}
