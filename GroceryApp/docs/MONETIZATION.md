# Monetization Plan (post-v1)

Decision (owner, 2026-07-06): **v1 ships fully free and self-hosted-only.**
The managed-tier UI is hidden behind `MANAGED_TIER_ENABLED = false` in
`SettingsScreen.tsx` because there is no in-app way to buy it, and Apple
Guideline 3.1.1 requires digital features/services used in-app to be sold via
In-App Purchase — an un-purchasable "subscription key" field invites rejection.

## Planned paid tier (v1.x)

A subscription unlocking:

1. **Trip Optimizer** (multi-stop savings planner — `src/pricing/basket-planner.ts`,
   `StopOptimizer.tsx`, `TripPlanSheet.tsx`; see `docs/PRICE_COMPARISON.md`)
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
