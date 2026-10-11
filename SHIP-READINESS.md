# PantryRun — ship readiness

State at `4764adf`+. Verified against a live EAS session on 2026-08-08. Goal set for this pass: **Android production, iOS first submission, and a
deployable hardened relay.** grocery-app retired.

## Verdict

| Target | State | What remains |
|---|---|---|
| **Relay** | **Ready to deploy — and now the app's default** | New installs sync to `wss://relay.pantryrun.app`. Deploy it (Pi + Cloudflare Tunnel): `GroceryApp/docs/deploy-hosted-relay.md`. Until it is live, default installs cannot sync. |
| **Android** | **Built and signed — awaiting upload** | AAB ready at versionCode 32; needs the Play service-account key or a manual Console upload. |
| **iOS** | **Code ready; blocked on Apple credentials** | EAS holds no iOS distribution creds — see §4. |

Every automated gate passes:

```
client   55 suites / 605 passed, 1 skipped
relay    11 suites / 102 passed
tsc --noEmit                     clean
gitleaks, full 20-commit history no leaks
release config check             19/22, 0 failed, 3 pending owner action
```

## 1. Relay — verified deployable, end to end

Not merely "tests pass": the server was booted with the same environment the container sets and
probed live.

```
boot with RELAY_PORT/POOL_PORT/RELAY_DATA_DIR/ISSUER_*_KEY_PATH   → starts clean
GET /health                                    → 200 {"status":"ok","version":"2.0"}
GET /stats            (no token)               → 401
GET /stats            (bad token)              → 403
Access-Control-Allow-Origin on /stats          → absent
state written to RELAY_DATA_DIR, not the repo  → confirmed, tree stayed clean
```

That exercises the audit's H4 fix at runtime, not just in a unit test. Container packaging is
guarded separately by `relay-server/deploy-image.test.js`, which asserts every module-scope
`require()` in `server.js` resolves to a path the Dockerfile actually COPYs — the static equivalent
of a boot test, and the exact defect that shipped undetected in the sibling repo.

**Not verified here:** an actual `docker build`/`docker run`. Docker is not installed on this
machine. Run `docker compose up -d` once and confirm `/health`; the CI workflow now does this on
every push (`.github/workflows/ci.yml`, "Smoke test — the built image actually boots").

**Hosted default (2026-10-11):** the app now defaults to the PantryRun-operated relay at
`wss://relay.pantryrun.app` (`docker compose --profile hosted up -d`, Cloudflare Tunnel for TLS —
`GroceryApp/docs/deploy-hosted-relay.md`). Because the developer now operates the relay, the
store privacy declarations were re-answered (`GroceryApp/docs/STORE_COMPLIANCE.md` §§1–2) and the
updated privacy policy, a support page and the app-link association files are ready to host in
`site/` (`site/README.md`). Still open outside this pass: in-app copy that says sync is
self-hosted (`PrivacyScreen.tsx` sync/flyer rows, the flyer-scan prompt in
`GroceryListScreen.tsx`).

**Before exposing a self-hosted relay:** terminate TLS in front of it (`docs/self-host-security.md`), and set
`ASSISTANT_REDIRECT_URIS` if voice-assistant linking is ever enabled — the OAuth allowlist is
fail-closed, so an unset value refuses every client, which is the safe default.

## 2. Android — ready

The release build was run here and produced a real artifact.

```
./gradlew assembleRelease   → BUILD SUCCESSFUL, 8m57s, 724 tasks
app-release.apk             → versionCode 31, versionName 1.31.0, targetSdk 36
```

The shipped cleartext policy was verified by decoding the resource **out of the built APK**, not by
reading the source: `base-config cleartextTrafficPermitted=false`, cleartext permitted only for
`localhost`, `127.0.0.1`, `10.0.2.2`, `10.0.3.2`, `home.arpa`, and the three public endpoints
explicitly denied.

Note the APK built here is **debug-signed** (the release signing config falls back to the debug
keystore when no upload key is configured) and is therefore not submittable. Build through EAS with
the real upload key.

## 3. Owner actions — 2 outstanding (was 3; version counters now done)

`cd GroceryApp && npm run check:release` is the machine-checkable form; it runs in CI on every push
and fails only on regression, reporting these as PENDING.

**a. EAS version counters — DONE, both platforms.** Verified against a live EAS session.
The project had no remote versions configured at all; both are now seeded from the native code:

```
eas build:version:get --platform android   ->  Android versionCode - 32
eas build:version:get --platform ios       ->  iOS buildNumber    - 31
```

A production Android build was run on 2026-08-09 and incremented 31 -> 32 on its own, using the
EXISTING keystore (`Build Credentials U2HMOIJrkW (default)`) — the same one that signed live v31, so
there is no signature-mismatch risk. **A submittable AAB now exists:**

```
AAB    https://expo.dev/artifacts/eas/C-iuuKIl43luvCo5Vuqs7PUFBaLiaexPrl8scxdfSMk.aab
build  6ca6e8d9-ece9-44c3-b5f4-1a913d41cfba   (versionCode 32, FINISHED, production profile)
```

Every locally-built APK before this fell back to the debug keystore and would have been rejected at
ingest. This is the first artifact Play will actually accept.

**Correction worth knowing:** with `appVersionSource: remote` AND committed native directories, EAS
**ignores `app.json`** and reads the native code — it says so explicitly. The seed that matters is
`android/app/build.gradle` versionCode and `ios/PantryRun/Info.plist` CFBundleVersion. An earlier
version of the release check guarded `app.json`, which EAS never reads; it now guards the native
values and was verified to fail when they are lowered.

**b. Provide the Play service-account key — the ONLY thing blocking the Android upload.**
`eas submit` was attempted on 2026-08-09 against build 6ca6e8d9 and failed on exactly this:

```
File ./credentials/play-service-account.json doesn't exist.
A Google Service Account JSON key is required to upload your app to Google Play Store.
```

EAS does NOT hold this credential server-side (unlike the keystore, which it does). Two ways to
finish, both one step:

1. Download the AAB from the link in (a) and upload it to the internal track in the Play Console.
   No service account needed at all.
2. Create a service account with the **Release Manager** role in Play Console -> Users and
   permissions, download the JSON to `GroceryApp/credentials/play-service-account.json` (already
   gitignored — verified with `git check-ignore`), then:

```bash
cd GroceryApp
npx eas-cli submit --platform android --profile production --id 6ca6e8d9-ece9-44c3-b5f4-1a913d41cfba
```

Note `submit.production.android.track` is `internal`, deliberately — promote to production from the
Console after verifying. Never commit the key.

**c. Fill in the Apple IDs.** `eas.json` `submit.production.ios` still has literal
`REPLACE_WITH_APP_STORE_CONNECT_APP_ID` / `REPLACE_WITH_APPLE_TEAM_ID`. These are account facts
recorded nowhere in the repo; inventing plausible values would be worse than placeholders that fail
loudly at `eas submit`.

## 4. iOS — what is proven, and what is not

**Proven:** the Release build compiles (`** BUILD SUCCEEDED **`), the app installs, launches, stays
alive, and renders its own React Native UI. Two ABI breaks that made launch impossible are fixed and
were verified by a symbol sweep over all 15 Mach-Os on both the arm64 and x86_64 slices — zero
unresolved symbols in every namespace.

**Not proven: that the app reaches its main screen.** It stops on its own "PantryRun couldn't start"
error boundary. The cause is understood and is not a defect in the app:

- `expo-secure-store` calls Keychain during `App.tsx` init.
- Keychain returns `-34018 errSecMissingEntitlement`, because a build made with
  `CODE_SIGNING_ALLOWED=NO` carries no `application-identifier`.
- `App.tsx` treats that as fatal.

Three routes were tried and all fail for environmental reasons, not code reasons: enabling code
signing wedges `xcodebuild` (this machine has **zero valid signing identities**); ad-hoc re-signing
with a synthetic `application-identifier` makes SpringBoard refuse the app outright
(`SBMainWorkspace` denied); and there is no provisioning profile to sign against.

**Both EAS routes were attempted on 2026-08-08 and are blocked on Apple credentials, not on code:**

```
--profile development  → "you don't have expo-dev-client installed"  (a native dep;
                          not added, because adding one unasked is what broke this
                          project repeatedly this session)
--profile preview      → "EAS CLI couldn't find any credentials suitable for internal
                          distribution. Run this command again in interactive mode."
```

EAS holds **no iOS distribution credentials** for this project. Creating them means signing into
Apple, which an agent must not do. Either route closes it once you run it yourself:

```bash
cd GroceryApp && npx eas-cli build --profile preview --platform ios   # interactive; EAS creates the cert/profile
# or: open ios/PantryRun.xcworkspace in Xcode, set your Apple ID as the team, Run
```

Expected result: init completes and the app reaches the list UI. If it still fails, capture the
error behind "Show details" — but every non-signing dependency of that path is already verified.

## 5. Local build note (not a repo change)

iOS builds from this checkout need:

```bash
APPLE="GroceryApp/node_modules/expo-modules-jsi/apple"
mkdir -p ~/Library/Developer/Xcode/DerivedData/ExpoModulesJSI
ln -sfn ~/Library/Developer/Xcode/DerivedData/ExpoModulesJSI "$APPLE/.DerivedData"
```

The repo lives under iCloud-synced `~/Documents`; the fileprovider stamps `com.apple.FinderInfo` on
`.framework` directories, and the ExpoModulesJSI build phase runs a nested `xcodebuild` under
`env -i` that codesigns and dies with "resource fork, Finder information, or similar detritus not
allowed". Proven with a control experiment: identical script and inputs failed from `~/Documents`
(exit 65) and succeeded from `/tmp` (exit 0). **Any `npm install` deletes the symlink.** EAS Build is
unaffected — it does not run inside iCloud.

## 6. Deliberately deferred

- **`@sentry/react-native` 8.14.0** and **`react-native-get-random-values` 2.0.0** — expo-doctor
  wants both *downgraded*. One sits in the crypto path. A product decision, not cleanup.
- **Voice-assistant / OAuth pairing (H5)** — hardened (CSPRNG codes at 39.3 bits, constant-time
  lookup, expiry, bounded attempts, fail-closed redirect allowlist) but the feature is default-off
  and its webhook is undeployed. Do not enable without the disclosure work in `docs/MONETIZATION.md`.
- **M5 end state** — Android now denies cleartext by default. LAN self-hosters on a bare
  `ws://192.168.x.x` must move to a `home.arpa` name or `wss://`; `docs/self-host-security.md` is
  migrated. Call this out in release notes.

## 7. Recommended sequence

1. Verify the EAS version counter (§3a).
2. `eas build --profile production --platform android` → promote in the Play console.
3. Provide the Play key (§3b) and the Apple IDs (§3c).
4. `eas build --profile development --platform ios`, confirm the app reaches its UI (§4).
5. `eas build --profile production --platform ios` → submit.
6. Deploy the hosted relay (`GroceryApp/docs/deploy-hosted-relay.md`); confirm
   `curl https://relay.pantryrun.app/health`. Do this **before** the store builds reach users —
   it is their default sync server.
7. Host `site/` on the pantryrun-site Worker with the real Team ID / SHA-256 (`site/README.md`).
