# Monetization Plan (post-v1)

## PantryRun Plus — how the in-app purchase works now (2026-10)

Plus is one auto-renewing annual subscription, `pantryrun_plus_annual`
(Play base plan `annual`), sold with react-native-iap 15. All entitlement
logic is in `src/config/entitlements.ts`; paywall copy in
`src/config/plus-paywall.ts`; the UI is `src/components/PlusPaywall.tsx`.

- **Paywall (Guideline 3.1.2).** Both selling surfaces (Settings › PantryRun
  Plus and the Trip Optimizer upsell on the list screen) open the same
  `PlusPaywall` modal: plan name, store-localized price and period
  (`loadPlusProduct` → `describePlusProduct`; Android reads the bare `annual`
  base plan, the same one `resolveAndroidOffers` buys), the auto-renewal /
  24-hour cancellation text, the charged account (Apple ID / Google Play),
  how to manage or cancel (deep link to the store's subscriptions page),
  Terms of Use and Privacy Policy links, Subscribe and Restore Purchases.
  `PLUS_PRICE_DISPLAY` ($14.99/year) is only a placeholder until the store
  answers.
- **App-lifetime listener.** `startEntitlementLifecycle()` (called once from
  `App.tsx` init) installs one `purchaseUpdatedListener` /
  `purchaseErrorListener` pair for the life of the app. Grants happen only on
  `purchaseState === 'purchased'`, after `finishTransaction` (which
  acknowledges on Android). `pending` (Play pending payment) and iOS
  `deferred-payment` (Ask to Buy) set `pendingPayment` — "payment pending" in
  the UI, no grant, no error — and are granted when the store later reports
  completion, even if the paywall was closed long before.
- **Restore** acknowledges any purchase with `isAcknowledgedAndroid === false`
  before granting.
- **Expiry and re-verification.** iOS `expirationDateIOS` is stored as
  `expiresAt` (Play exposes no expiry to the client; `null`). Expiry is
  honoured with a 7-day grace (`EXPIRY_GRACE_MS`) so offline subscribers and
  family devices waiting for a renewal to sync are not locked out. At launch
  and on background→active (≥ 5 min apart) the purchasing device re-asks
  `getAvailablePurchases`:
  - active → acknowledge if needed, refresh expiry/transaction, re-publish;
  - **definitive "none"** (successful, well-formed answer with no active Plus)
    for a record this device's store account owns (`source` purchase/restore,
    same platform) → revoke locally and publish a tombstone (`revokedAt`) to
    the family doc, which family devices honour for their `sync` copy;
  - store error, offline, malformed answer, pending → **no change** (fail-open
    for the honest user).
- **Family scope.** A `sync` record only entitles while its `familyId`
  matches the device's current family (re-read at resolve and on foreground;
  `refreshFamilyScope()` applies it immediately). The buyer's own purchase is
  not family-scoped.
- Still honest-user gating: no server-side receipt validation (see the
  stance in `entitlements.ts`). App Store Server Notifications / Play RTDN
  would make revocation reach family devices without the purchaser opening
  the app; not built.

### Store configuration the code cannot do (owner)

App Store Connect:
- Subscription group (e.g. "PantryRun Plus") containing the auto-renewable
  subscription `pantryrun_plus_annual`, duration 1 year, price, and a
  localized display name + description; submit it with the binary.
- App Information › License Agreement: keep Apple's standard EULA or upload
  a custom one, AND put a Terms of Use (EULA) link in the App Description
  (or the custom EULA field) plus the Privacy Policy URL
  (https://www.pantryrun.app/privacy) — review checks the metadata too.
- Paid Applications agreement, tax and banking must be active, or products
  never load (the paywall then stays on the fallback price and purchases
  fail with "not available").
- Review notes: a sandbox tester account and where the paywall is
  (Settings › PantryRun Plus, or a list's Trip Optimizer upsell).
- Optional: App Store Server Notifications V2 URL (nothing consumes it yet).

Play Console:
- Payments profile / merchant account.
- Subscription product `pantryrun_plus_annual` with an ACTIVE base plan whose
  ID is exactly `annual`, auto-renewing, billing period 1 year
  (`PLUS_BASE_PLAN_ID`). Offers are optional; the app always buys the bare
  base plan.
- Enable/allow pending purchases for subscriptions if wanted (the app handles
  them); grace period / account hold settings are honoured by the store's
  answer.
- License testers for testing; the app must be installed from a Play track.
- Data safety: purchase history.
- `https://www.pantryrun.app/terms` and `/privacy` must be live pages.

Decision (owner, 2026-07-06): **v1 ships fully free and self-hosted-only.**
The managed-tier UI is hidden behind `MANAGED_TIER_ENABLED = false` in
`SettingsScreen.tsx` because there is no in-app way to buy it, and Apple
Guideline 3.1.1 requires digital features/services used in-app to be sold via
In-App Purchase — an un-purchasable "subscription key" field invites rejection.

## Planned paid tier (v1.x)

A subscription unlocking:

1. **Trip Optimizer** (multi-stop savings planner — `src/pricing/stop-optimizer.ts`,
   `trip-plan.ts`, `StopOptimizer.tsx`, `TripPlanSheet.tsx`)
2. **Smart Home / voice-assistant integration** (Alexa + Google Assistant)

## Hard prerequisites — read before building

### Payments
- Must use **StoreKit/Play Billing via IAP** (e.g. `react-native-iap` or
  RevenueCat). Server-side receipt validation is strongly recommended; do not
  gate on an unvalidated client flag alone.
- Adding the IAP SDK is a native dependency → needs a real EAS build + store
  products configured (owner: App Store Connect / Play Console product IDs).
- Entitlement checks should live in ONE module (suggest `src/config/entitlements.ts`
  when built) so Trip Optimizer and Smart Home gate through a single point.
- ⚠️ This repo is public (per README). Client-side gating is trivially
  bypassable by building from source — acceptable for honest-user monetization,
  but price the expectation accordingly; receipt-validated server features
  (managed relay, assistant webhook hosting) are the defensible part.

### Smart Home specifically — SECURITY PRECONDITION
**Key-custody flaw is FIXED (2026-07-06)** — the relay no longer holds the
assistant private key (only the webhook does; see
`docs/ARCHITECTURE-VOICE-ASSISTANTS.md` and `assistant-keygen.js`). So the
relay can no longer decrypt linked families' data. The feature is still
disabled in v1 (`VOICE_ASSISTANT_LINKING_ENABLED=false` /
`ASSISTANT_INTEGRATION` off).

Remaining work before this can be **sold**:
1. **Deploy the webhook** (Cloud Function / Lambda) holding `ASSISTANT_PRIVATE_KEY`;
   provision the public key to the relay. Neither is deployed today.
2. **Least privilege (recommended):** today the app uses the master key
   directly as the sync key (no key hierarchy), so linking would hand the
   webhook the *root* master key. Introduce a derived `yjs-sync` subkey
   (`crypto_kdf_derive_from_key`) used by BOTH the client sync channel and the
   webhook, and upload only that subkey — so a compromised webhook can read/
   write lists but cannot derive other subkeys. This is a change to the core
   sync key path (re-key/migration), which is why it's deferred out of the v1
   hardening pass, not done inline.
3. **Disclosure:** in-app consent ("voice assistant linking sends your list
   contents to our servers to answer voice requests") + matching App Store
   privacy-label / Play data-safety updates. The webhook transiently seeing
   plaintext is inherent to cloud voice and must be disclosed, not claimed away.

Charging for it raises the bar: a paid feature that weakens the product's
zero-knowledge promise is both a trust and a review liability, so the
disclosure (3) is non-negotiable even though the relay custody (fixed) no
longer is.

### Trip Optimizer specifically
- Fully client-side — gating it is purely an entitlement check in the
  `GroceryListScreen` render path (now implemented:
  `src/config/entitlements.ts` is the single entitlement module).
- No grandfathering is needed and none should be built: the owner gated the
  feature OFF before v1 shipped (`TRIP_OPTIMIZER_ENABLED = false` in the v1
  binary), precisely so no user ever had it free. The pre-paywall cohort is
  empty — do not add exemption logic for an empty set. (This corrects
  earlier guidance written before the v1 gating decision.)

### Store paperwork when this lands
- Add subscription products + `NSPrivacyCollectedDataTypes` review (purchase
  data), update Play Data Safety (purchase history if collected).
- Re-answer the "does your app include paid digital content" questions.
- Managed tier re-enable = flip `MANAGED_TIER_ENABLED` + wire the key to real
  entitlement validation (today the key is stored but validates nothing).
