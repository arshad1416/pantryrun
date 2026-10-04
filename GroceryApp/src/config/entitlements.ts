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
export const PLUS_PRICE_DISPLAY = '$14.99/year';

/**
 * Paywall copy. States precisely what the savings figure compares against:
 * basket-planner.ts compares routes of one, two or three stores that buy the
 * SAME items, merchandise only (tax, travel and fees are not included), and
 * states no saving when the routes cover different items.
 */
export const PLUS_PAYWALL_COPY =
  'PantryRun Plus unlocks the Trip Optimizer: compare splitting your list ' +
  'across up to three nearby stores, using the prices you have, with every ' +
  'route showing which items it covers and where each price came from. ' +
  'Savings are merchandise-only, before tax and travel. One purchase ' +
  `unlocks your whole family. ${PLUS_PRICE_DISPLAY}.`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlusEntitlement {
  familyId: string;
  productId: string;
  platform: 'ios' | 'android' | 'unknown';
  transactionId: string;
  purchasedAt: number;
  /** null = non-expiring (store manages renewal; we re-check on restore). */
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
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useEntitlementStore = create<EntitlementState>(() => ({
  isPlus: false,
  record: null,
  resolution: 'unresolved',
  busy: false,
  lastError: null,
}));

/** Synchronous read for non-React callers. Resolve first via resolveEntitlement(). */
export function isPlusEntitled(): boolean {
  return useEntitlementStore.getState().isPlus;
}

// ─── Entitlement computation (the only place this logic exists) ──────────────

function computeIsPlus(record: PlusEntitlement | null): boolean {
  if (!record) return false;
  if (record.productId !== PLUS_PRODUCT_ID) return false;
  if (!record.transactionId) return false;
  if (record.expiresAt !== null && record.expiresAt < Date.now()) return false;
  return true;
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

// ─── Family Yjs document (cross-device sync) ─────────────────────────────────

const FAMILY_DOC_ID = '__family__';

function writeRecordToFamilyDoc(record: PlusEntitlement): void {
  const doc = getDoc(FAMILY_DOC_ID);
  doc.transact(() => {
    doc.getMap('entitlements').set(PLUS_PRODUCT_ID, {
      familyId: record.familyId,
      productId: record.productId,
      platform: record.platform,
      transactionId: record.transactionId,
      purchasedAt: record.purchasedAt,
      expiresAt: record.expiresAt,
    });
  });
}

let familyDocObserverInstalled = false;

/**
 * Watch the family doc's entitlements map so a purchase made on another
 * family device (applied whole-document via Y.applyUpdate in sync-manager)
 * lands here: persisted locally with source 'sync', then resolved.
 */
function installFamilyDocObserver(): void {
  if (familyDocObserverInstalled) return;
  familyDocObserverInstalled = true;
  const map = getDoc(FAMILY_DOC_ID).getMap('entitlements');
  const apply = () => {
    const raw = map.get(PLUS_PRODUCT_ID) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') return;
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
    const current = useEntitlementStore.getState().record;
    if (current && current.transactionId === synced.transactionId) return;
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

// ─── Grant path (shared by purchase / restore / sync) ────────────────────────

async function grantEntitlement(record: PlusEntitlement): Promise<void> {
  await persistLocalRecord(record);
  writeRecordToFamilyDoc(record);
  // Make sure the family doc's update observer is sending, so the grant
  // reaches the rest of the family. Dynamic import: useSyncStore already
  // imports syncManager statically, a static back-import here would cycle.
  try {
    const { syncManager } = await import('../sync/sync-manager');
    syncManager.registerList(FAMILY_DOC_ID);
  } catch (err) {
    console.warn('[entitlements] family doc sync registration failed:', err);
  }
  useEntitlementStore.setState({ isPlus: computeIsPlus(record), record, resolution: 'resolved' });
  console.log(`[entitlements] granted via ${record.source} (tx ${record.transactionId})`);
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

type IapPurchase = {
  productId?: string;
  transactionId?: string | null;
  /** Unified purchase token (iOS JWS, Android purchaseToken). */
  purchaseToken?: string | null;
  transactionDate?: number;
};

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
    expiresAt: null, // stores own renewal; restore re-checks with the store
    source,
  };
}

/** One Google Play subscription offer, as `requestPurchase` wants it. */
export type GoogleSubscriptionOffer = { sku: string; offerToken: string };

/**
 * The base plan the paywall price refers to.
 *
 * PLUS_PRICE_DISPLAY above is a hardcoded string rendered onto the Subscribe
 * button, so whatever we buy MUST be this plan. Play returns one entry per
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
  // the charge matches PLUS_PRICE_DISPLAY on the Subscribe button.
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

/**
 * Buy PantryRun Plus on this device's store account, then unlock the family.
 * Returns true when the entitlement was granted.
 */
export async function purchasePlus(): Promise<boolean> {
  useEntitlementStore.setState({ busy: true, lastError: null });
  try {
    const iap = await import('react-native-iap');
    await iap.initConnection();

    // Google Play Billing v5+ requires a REAL offer token, obtained from the
    // store for the specific base plan being bought. This used to pass the
    // empty string with a comment claiming Play would resolve the offer in its
    // own UI — it does not; Billing rejects the request. The token is only
    // knowable at runtime (Play mints it per product/base-plan), so it has to
    // be fetched immediately before the purchase rather than hardcoded.
    //
    // iOS ignores subscriptionOffers entirely and keys off `apple.sku`.
    const googleOffers = await resolveAndroidOffers(iap);

    // Store events emitted while no JS listener was attached are buffered
    // natively and flushed to the first listener that attaches, so the first
    // event seen here is not necessarily the one just requested.
    //
    // On the SUCCESS side, acting on a stranger's event finishes the wrong
    // transaction, grants a record whose productId fails computeIsPlus, and
    // still returns true — a silent no-unlock — while the real purchase lands
    // after both listeners are gone, never gets finishTransaction, and Play
    // auto-refunds it in ~3 days. On the ERROR side the same flush rejects the
    // real purchase, with the identical never-finished consequence.
    //
    // The predicate is deliberately asymmetric: skip only events that name a
    // DIFFERENT product. An event carrying no identity at all settles the
    // promise exactly as it did before. A strict `!== PLUS_PRODUCT_ID` would
    // hang forever on one — and PurchaseError.productId is optional and
    // nullable (types.d.ts:1319-1320), which is precisely the shape a user
    // cancellation arrives in. Hanging leaves `busy: true` stuck with no alert
    // and no way out but an app restart.
    const names = (x: any): string[] =>
      [x?.productId, ...(x?.ids ?? []), ...(x?.productIds ?? [])].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
    const isSomeoneElses = (x: any) => {
      const n = names(x);
      return n.length > 0 && !n.includes(PLUS_PRODUCT_ID);
    };

    const purchase = await new Promise<IapPurchase>((resolve, reject) => {
      const okSub = iap.purchaseUpdatedListener((p: any) => {
        if (isSomeoneElses(p)) return;
        okSub.remove();
        errSub.remove();
        resolve(p as IapPurchase);
      });
      const errSub = iap.purchaseErrorListener((e: any) => {
        if (isSomeoneElses(e)) return;
        okSub.remove();
        errSub.remove();
        reject(new Error(e?.message ?? e?.code ?? 'purchase failed'));
      });
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
          okSub.remove();
          errSub.remove();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    });

    if (!receiptPresent(purchase)) {
      throw new Error('Purchase did not return a store receipt — not granting.');
    }
    await iap.finishTransaction({ purchase: purchase as any, isConsumable: false });
    await grantEntitlement(await purchaseToRecord(purchase, 'purchase'));
    return true;
  } catch (err: any) {
    const message = err?.message ?? String(err);
    // User cancellation is not an error state worth surfacing loudly.
    const cancelled = /cancel/i.test(message);
    // `lastError` is rendered straight into Alert.alert('Purchase failed', …) by
    // GroceryListScreen:126/137 and SettingsScreen:711/727, so it has to read as
    // something a buyer can act on. Store-configuration failures carry a
    // separate userMessage; the operator detail stays in the log, where it is
    // actually useful. Telling a customer to "activate a base plan in Play
    // Console" is a support ticket, not an error message.
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
    const purchases = (await iap.getAvailablePurchases()) as unknown as IapPurchase[];
    const match = purchases.find(
      (p) => p.productId === PLUS_PRODUCT_ID && receiptPresent(p),
    );
    if (!match) {
      useEntitlementStore.setState({ lastError: 'No previous purchase found on this store account.' });
      return false;
    }
    await grantEntitlement(await purchaseToRecord(match, 'restore'));
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
