# PantryRun — Store Compliance Reference

> **Declarations last reviewed:** October 11, 2026, against **v1.31.0** with the
> PantryRun-hosted relay as the default (`wss://relay.pantryrun.app`).
> **Package:** `com.shiftlogichq.pantryrun`
> **Privacy policy URL (everywhere):** `https://www.pantryrun.app/privacy`
> **Support URL:** `https://www.pantryrun.app/support` (page in `site/support/`,
> deploy it first — it 404s until then)

This document contains all declarations needed for Google Play Console and Apple App Store Connect submissions.

> **Declaration basis — read this first.** Earlier builds were answered as
> "no data collected" because every flow went to a relay the *user* ran. That
> is no longer true: new installs sync through a relay **the developer
> operates**, so anything that relay can read or keeps is developer
> collection. What the PantryRun relay receives:
>
> | Flow | Readable by the developer? | Retained? |
> |---|---|---|
> | Encrypted list updates (Yjs, XChaCha20-Poly1305) | No — ciphertext; keys never leave the family's devices | Up to 30 days (`UPDATE_TTL_MS`) |
> | Routing metadata: family ID, list ID, device ID (app-generated random IDs), device public key, timestamps, message sizes | Yes | Enrollments: 30 days after last connect; update metadata: with the update |
> | IP address | Yes (in memory, rate limiting; not written to relay state) | No (Cloudflare edge logs per Cloudflare's policy) |
> | Flyer photo (user-initiated, EXIF-stripped) | Yes — not E2E encrypted | No — processed and discarded; may pass to Alibaba Cloud Qwen-VL if `QWEN_API_KEY` is set |
> | Region code (FSA, 3 chars) for deals / shelf prices | Yes | No (response cache is keyed by FSA, not by device) |
> | Anonymous price contribution (opt-in, blind-token, no IDs) | Yes, unlinkable | Yes (pool) |
>
> Still true: no accounts, no analytics/ads SDKs, Sentry has no DSN in any
> build, no push tokens, Open Food Facts (and USDA only if a build sets
> `EXPO_PUBLIC_USDA_API_KEY`) receive a barcode number alone, purchases are
> processed by Apple / Google. **Self-hosters** are unchanged — but the store
> forms describe the default configuration, which is the hosted relay.

---

## 0. Export Compliance (Encryption) — REQUIRED, EASY TO GET WRONG

PantryRun implements real end-to-end encryption (libsodium XChaCha20-Poly1305,
Argon2id, Ed25519, Curve25519, RFC 9474 blind RSA). This is more than
HTTPS/OS-provided crypto, so it does NOT qualify for Apple's "exempt" answer.

### iOS
- `ITSAppUsesNonExemptEncryption` is set to `true` in `app.json` (ios.infoPlist).
- In App Store Connect's encryption questions answer:
  - *Does your app use encryption?* → **Yes**
  - *Does your app qualify for any of the exemptions?* → **No**
  - *Does your app implement proprietary or non-standard encryption?* → **No**
    (all algorithms are standard, published ones via libsodium)
  - *Is your app going to be available in France?* → if yes, France has its own
    declaration; standard-algorithm mass-market apps use the simplified process.
- US export classification: mass-market software using standard cryptography →
  self-classify as **5D992.c** under License Exception ENC §740.17(b)(1) and
  email the annual **self-classification report** to BIS + NSA
  (crypt-supp8@bis.doc.gov, enc@nsa.gov) — one line item, once per year.

### Google Play
- Play Console asks about export compliance in **App content → Government
  regulations** (wording varies). Answer consistently with the above: uses
  standard encryption for user-data protection; mass-market; self-classified
  5D992.c.

---

## 1. Google Play — Data Safety Section

Navigate to: **Play Console → PantryRun → App Content → Data Safety**

Google treats data as "collected" when it is transmitted off the device to the
developer or a third party. Exemptions: on-device processing, and
transfers to **service providers** processing on your behalf (those are not
"sharing"). "Processed ephemerally" is a per-type flag, not an exemption.
Answered conservatively:

### Data collection and security

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** (TLS to `relay.pantryrun.app`, Open Food Facts, USDA; list content additionally E2E) |
| Do you provide a way for users to request that their data is deleted? | **Yes** — in-app Settings → Danger Zone → Delete All Data; relay copies expire after 30 days or on request to privacy@pantryrun.app |

### Data types to declare

| Play data type | Collected | Shared | Ephemeral | Required / optional | Purpose | Why |
|---|---|---|---|---|---|---|
| **Photos and videos → Photos** | Yes | No ¹ | **Yes** | Optional (user starts a flyer scan) | App functionality | Flyer photo goes to the developer's relay unencrypted for price extraction, then is discarded |
| **Device or other IDs** | Yes | No | No | Optional (only once you pair / invite) | App functionality | Relay stores app-generated device ID, family ID and device public key for routing, up to 30 days after last connect |
| **Location → Approximate location** | Yes | No | **Yes** | Optional | App functionality | The 3-character postal prefix (FSA) is sent for regional deal / shelf-price lookups; not stored per device |

¹ If the operator sets `QWEN_API_KEY`, flyer photos are sent to Alibaba Cloud
(DashScope) as a **service provider** processing on our behalf — that is not
"sharing" under Play's definition, but it must be named in the privacy policy
(it is, §7).

**Not declared, with reasons** (re-check if any of these change):

- **List contents (ciphertext sync) — discussion.** The lists reach the relay
  only as XChaCha20-Poly1305 ciphertext the developer cannot decrypt (keys exist
  only on the family's devices / recovery phrase). Play's guidance treats
  end-to-end encrypted data the developer cannot read as not requiring
  disclosure — **confirm the current wording of Play's Data safety help article
  at submission time.** If the wording does not clearly cover it, the
  conservative answer is to declare **App activity → Other user-generated
  content: collected, not shared, not ephemeral, optional, App functionality**.
  Declaring it costs little; omitting it wrongly is a policy violation. Our
  recommendation: **declare it** unless the article explicitly exempts E2E data.
- **Barcode number → Open Food Facts / USDA:** sent directly from the device to
  fetch a product name, with no identifier; not a Play user-data type, and the
  developer receives nothing.
- **Purchase history:** purchases go through Google Play Billing; the app keeps
  the entitlement inside the family's encrypted data and sends nothing to the
  developer.
- **Price contributions (opt-in):** blind-token, no device/family ID, week-level
  timestamp — anonymous; not user data under Play's definition. If in doubt,
  declare **App activity → Other actions** as optional, not linked.
- **Crash logs:** none sent (no Sentry DSN).
- **IP address:** not a Play data type; disclosed in the privacy policy.

### Security Practices

| Practice | Status |
|----------|--------|
| Data is encrypted in transit | ✅ Yes |
| Users can request data deletion | ✅ Yes (in-app + privacy@pantryrun.app for relay copies) |
| Committed to following the Families Policy | ❌ No (not targeted at children) |
| Independent security review | Optional; not claimed |

**URL of your app's privacy policy:**
→ `https://www.pantryrun.app/privacy`

---

## 2. Apple App Store — App Privacy Labels

Navigate to: **App Store Connect → PantryRun → App Privacy**

Apple's definition of "collect" is transmitting data off the device in a way
that is accessible to the developer or third-party partners for longer than
necessary to service the request in real time.

#### Data Used to Track You
→ **No** — PantryRun does not track users across apps or websites.

#### Data Collected → **Yes**, configure these types:

| Apple data type | Linked to the user? | Tracking? | Purpose | Why |
|---|---|---|---|---|
| **User Content → Photos or Videos** | No | No | App Functionality | Flyer photos the user chooses to upload reach the developer's relay (and possibly Alibaba Cloud as processor) unencrypted. Processed and discarded, but readable by the developer, so declare it |
| **Identifiers → Device ID** | No | No | App Functionality | App-generated random device ID + family ID kept by the relay for routing (30 days after last connect). No account, so not linked to an identity |

"Linked to you" = linked to the user's identity (account, name, email, phone).
PantryRun has none of those, so both are **Data Not Linked to You**.

**Not declared, with reasons:**

- **Other User Content (ciphertext lists) — discussion.** The relay keeps
  E2E-encrypted updates for up to 30 days but the developer cannot read them;
  under Apple's "accessible to the developer" test they are arguably not
  collected. Conservative alternative: declare **User Content → Other User
  Content, Not Linked, App Functionality**. Recommendation: declare it if App
  Review asks, or if you prefer the label to match the Play answer above.
- **Coarse Location (FSA):** sent only to service the lookup, not retained per
  device → not collected under Apple's definition.
- **Purchases:** processed by Apple; nothing reaches the developer.
- **Crash Data:** none (no Sentry DSN).
- **Barcode → Open Food Facts:** serviced in real time, no identifier.

This matches `NSPrivacyCollectedDataTypes` in `app.json` and
`ios/PantryRun/PrivacyInfo.xcprivacy` (PhotosorVideos + DeviceID, not linked,
no tracking, App Functionality). Keep the label and the manifest in step.

### Privacy Nutrition Label Summary (What Users See)

```
Data Not Linked to You
  The following data may be collected but it is not linked to your identity:
  • User Content (Photos or Videos)
  • Identifiers (Device ID)

Data Used to Track You: None
```

### Privacy Policy URL for App Store Connect
→ `https://www.pantryrun.app/privacy`

---

## 3. Apple Privacy Manifest (NSPrivacyManifest)

Configured in `app.json` under `expo.ios.privacyManifests` and committed in
`ios/PantryRun/PrivacyInfo.xcprivacy` (the native file is what ships — the
native tree is committed):

```json
{
  "NSPrivacyTracking": false,
  "NSPrivacyTrackingDomains": [],
  "NSPrivacyAccessedAPITypes": [
    { "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp", "NSPrivacyAccessedAPITypeReasons": ["C617.1"] },
    { "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults", "NSPrivacyAccessedAPITypeReasons": ["CA92.1"] },
    { "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategorySystemBootTime", "NSPrivacyAccessedAPITypeReasons": ["35F9.1"] },
    { "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryDiskSpace", "NSPrivacyAccessedAPITypeReasons": ["E174.1"] }
  ],
  "NSPrivacyCollectedDataTypes": [
    {
      "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypePhotosorVideos",
      "NSPrivacyCollectedDataTypeLinked": false,
      "NSPrivacyCollectedDataTypeTracking": false,
      "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]
    },
    {
      "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeDeviceID",
      "NSPrivacyCollectedDataTypeLinked": false,
      "NSPrivacyCollectedDataTypeTracking": false,
      "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]
    }
  ]
}
```

### API Reason Codes Explained

| API | Reason Code | Explanation |
|-----|-------------|-------------|
| File Timestamp (C617.1) | App uses file timestamps for database sync versioning |
| UserDefaults (CA92.1) | App stores user preferences and settings locally |
| System Boot Time (35F9.1) | Used for performance timing and session management |
| Disk Space (E174.1) | Checked before database operations to prevent corruption |

---

## 4. Store Listing — Required Links & Text

### Google Play Store Listing

**Privacy Policy URL:**
```
https://www.pantryrun.app/privacy
```

**Short Description (80 chars max):**
```
Private family grocery lists. End-to-end encrypted sync. No accounts needed.
```

**Full Description excerpt for privacy:**
```
🔒 PRIVACY-FIRST
• Your lists stay on YOUR device and sync end-to-end encrypted
• No accounts, no sign-ups, no ads, no analytics, no tracking
• Free sync through the PantryRun relay, which can't read your lists — or run your own server
• Read exactly what we can and can't see: www.pantryrun.app/privacy
```

### Apple App Store Listing

**Privacy Policy URL:**
```
https://www.pantryrun.app/privacy
```

**Support URL:**
```
https://www.pantryrun.app/support
```

---

## 5. Runtime Permission Rationale Strings

### Android (for `shouldShowRequestPermissionRationale`)

#### Camera
**Title:** `Camera Access`
**Message:** `PantryRun uses your camera to scan barcodes, scan QR pairing codes, and photograph store flyers for price extraction. Barcode/QR frames are processed in real-time and discarded. Flyer photos are sent (without location metadata) to your sync relay for automated price extraction, then discarded.`

#### Microphone
**Not requested on Android.** The app declares no RECORD_AUDIO permission and
never records audio.

#### Notifications (Android 13+)
**Title:** `Notification Permission`
**Message:** `PantryRun sends local notifications for shopping reminders and family list updates. No remote push notifications — all notifications come from the app on your device.`

### iOS (Info.plist strings — in app.json and the committed Info.plist)

| Key | Value |
|-----|-------|
| NSCameraUsageDescription | Scan barcodes to add items to your grocery list, scan QR codes to join your family, and photograph store flyers for price extraction |
| NSPhotoLibraryUsageDescription | Select a store flyer photo from your library so PantryRun can read its prices |
| NSMicrophoneUsageDescription | PantryRun never records audio. iOS asks for this because the camera component used for barcode, QR and flyer scanning can also record video with sound; PantryRun does not use that. |
| NSLocalNetworkUsageDescription | PantryRun connects to your self-hosted sync relay on your local network to keep your family's grocery lists in sync |
| ITSAppUsesNonExemptEncryption | true (see Section 0) |

> **Microphone:** the purpose string is back (2026-10-11) for a binary reason,
> not a feature: `expo-camera` links AVFoundation audio-recording APIs, and App
> Store processing flags binaries that reference microphone APIs without
> `NSMicrophoneUsageDescription`. The app never calls them, never prompts for
> the microphone, and the string says so. Speech recognition, the Siri
> entitlement and the App Group entitlement remain removed.

---

## 6. Sentry — NOT ACTIVE IN v1

**No v1 build contains a Sentry DSN** (owner decision, 2026-07-28): `eas.json`
carries no `EXPO_PUBLIC_SENTRY_DSN`, no EAS dashboard env vars are set, and
`src/services/sentry.ts` exits before `Sentry.init()` when the DSN is empty.
Crash Data is therefore NOT declared on either store — declaring it for an SDK
that never initializes would be an over-declaration.

### Re-enabling later (all four steps or none):
1. Put the real DSN in `eas.json` → `build.production.env.EXPO_PUBLIC_SENTRY_DSN`.
2. Add **Crash Data** to the declarations in §§1–2 (Apple: Crash Data → App Functionality; Play:
   App info and performance → Crash logs, shared with Sentry).
3. Restore the Crash Reporting section of `privacy/index.html` and the
   PrivacyScreen toggle (the `sentryEnabled` setting still exists and defaults
   to on — the code path is ready).
4. Keep `sendDefaultPii: false` and the breadcrumb stripping already in
   `sentry.ts`.

---

## 7. Hosted (PantryRun relay) vs Self-Hosted — What Differs for Compliance

> The hosted tier is now **on and the default** (`MANAGED_TIER_ENABLED = true`
> in SettingsScreen.tsx), and it is **free** — nothing about it is sold, so it
> adds no purchase path. The old un-buyable subscription-key input is not
> rendered (Apple 3.1.1: the only purchase path is the `pantryrun_plus_annual`
> IAP, see `audit-package/08-SUBMISSION-HANDOFF.md` §5). Deployment:
> `docs/deploy-hosted-relay.md`.

| Aspect | Self-Hosted | PantryRun relay (default) |
|--------|-------------|---------------------------|
| **Relay server** | User runs it | Developer runs it (`relay.pantryrun.app`, behind Cloudflare) |
| **Data at rest on server** | Encrypted blobs + routing metadata (30-day retention) | Same — encrypted blobs + routing metadata, 30-day retention |
| **Flyer photos** | User's relay (+ whatever extractor they configure) | Developer's relay; Ollama on our hardware, or Alibaba Cloud Qwen-VL if `QWEN_API_KEY` is set |
| **Store data-safety forms** | Would be "no collection" | Declarations in §§1–2 |
| **Data deletion** | In-app Delete All Data; operator deletes relay data | In-app Delete All Data; relay copies expire in 30 days or on email to privacy@pantryrun.app |
| **Price scraping toggle** | Available (no sources implemented yet) | Shown, disabled ("Self-host only") |
| **Crash reporting** | None (no Sentry DSN) | None |

---

## 8. Checklist: Before Submitting

### Google Play Console
- [ ] Data Safety form filled per Section 1 (Photos, Device or other IDs, Approximate location; decide on Other user-generated content)
- [ ] Export compliance / government regulations answered (see Section 0)
- [ ] Privacy policy URL: `https://www.pantryrun.app/privacy` — with the updated policy (`site/privacy/index.html`) deployed
- [ ] `INTERNET` permission justified
- [ ] `READ_EXTERNAL_STORAGE` maxSdkVersion=32 justified
- [ ] No SYSTEM_ALERT_WINDOW (removed)
- [ ] Target API level meets Play's floor. **From August 31, 2026, new apps
      and updates must target SDK 36 (Android 16)** — confirm the build's
      target before submitting. Source:
      https://support.google.com/googleplay/android-developer/answer/11926878
- [ ] Release bundle signed with the upload keystore (PANTRYRUN_UPLOAD_* gradle
      props or EAS credentials) — NOT the debug keystore
- [ ] versionCode/versionName in android/app/build.gradle match app.json
- [ ] `https://pantryrun.app/.well-known/assetlinks.json` and the `www.` copy
      deployed with the app-signing SHA-256 (`site/README.md`)

### Apple App Store Connect
- [ ] App Privacy labels configured per Section 2 (Photos or Videos + Device ID, not linked)
- [ ] Encryption questions answered (see Section 0); ITSAppUsesNonExemptEncryption=true in build
- [ ] Annual BIS self-classification report filed (5D992.c)
- [ ] Privacy policy URL: `https://www.pantryrun.app/privacy`
- [ ] Support URL: `https://www.pantryrun.app/support` (deployed, not 404)
- [ ] Privacy manifest included in build (`ios/PantryRun/PrivacyInfo.xcprivacy`)
- [ ] Info.plist usage descriptions present (incl. NSMicrophoneUsageDescription)
- [ ] No tracking (NSPrivacyTracking = false)
- [ ] apple-app-site-association deployed at
      `https://pantryrun.app/.well-known/apple-app-site-association` **and**
      `https://www.pantryrun.app/.well-known/apple-app-site-association` with the
      real Team ID (`site/.well-known/` has the `TEAMID` placeholder)
- [ ] Hosted relay live: `curl https://relay.pantryrun.app/health` → `{"status":"ok",…}`

### In-App
- [ ] Privacy screen accessible from Settings
- [ ] Delete All Data flow works (confirmation → wipe → fresh state)
- [ ] Price lookup opt-in with disclosure works
- [ ] Barcode lookup consent prompt shows before first scan
- [ ] Permission rationale modal shows before OS dialog
- [ ] Links to privacy policy and ToS work
- [ ] In-app PrivacyScreen copy no longer says sync is self-hosted only (see the
      open item in SHIP-READINESS.md)
