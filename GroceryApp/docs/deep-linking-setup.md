# Deep Linking Setup — GroceryApp

> **Current hosts (2026-10):** links use `pantryrun.app` **and** `www.pantryrun.app`
> (both are in the iOS entitlements and the Android autoVerify filter), so the
> association files must be served on both. Ready-to-host copies and deploy steps:
> `site/README.md` at the repo root. `groceryapp.app` was never registered.

## Overview

GroceryApp supports three deep linking mechanisms for invite flows:

1. **Custom URL scheme** (`groceryapp://invite?token=...`, the scheme every build generates; `pantryrun://` is also registered) — works when the app is already installed
2. **Universal Links (iOS) / App Links (Android)** (`https://pantryrun.app/invite?token=...`) — seamless
   open-in-app without the "open this page?" prompt
3. **Web fallback page** (hosted on relay server) — detects when the app isn't installed and redirects
   to App Store / Google Play

---

## 1. Hosting Verification Files

Both Apple and Google require JSON files hosted at a well-known path on your domain to verify
app ownership.

### iOS — `apple-app-site-association`

**File location in repo:** `ios/apple-app-site-association` (no `.json` extension)

**Served at:** `https://pantryrun.app/.well-known/apple-app-site-association`

Before deploying:

1. Replace `TEAMID` with your Apple Team ID (found in [Apple Developer Portal](https://developer.apple.com/account))
2. Replace `com.shiftlogichq.pantryrun` with your actual bundle identifier if different
3. Serve the file with `Content-Type: application/json` and no redirects

**Content:**

```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "TEAMID.com.shiftlogichq.pantryrun",
        "paths": ["/invite/*"]
      }
    ]
  }
}
```

### Android — `assetlinks.json`

**File location in repo:** `android/assetlinks.json`

**Served at:** `https://pantryrun.app/.well-known/assetlinks.json`

Before deploying:

1. Replace `com.shiftlogichq.pantryrun` with your actual Android package name if different
2. Replace `REPLACE_WITH_RELEASE_CERT_FINGERPRINT` with your app's SHA-256 release certificate
   fingerprint. You can generate this with:
   ```bash
   keytool -list -v -keystore your-release-key.keystore -alias your-key-alias \
     | grep "SHA256:" | awk '{print $2}'
   ```
3. Serve the file with `Content-Type: application/json`

---

## 2. iOS Configuration

### Add Associated Domains Entitlement

1. Open your project in Xcode
2. Select the app target → **Signing & Capabilities**
3. Click **+** → **Associated Domains**
4. Add:
   ```
   applinks:pantryrun.app
   ```
5. Also add the custom scheme:
   - Go to **Info** → **URL Types**
   - Add URL scheme: `grocceryapp`

### Alternative: Via `app.json` (Expo)

If using Expo, configure in `app.json`:

```json
{
  "expo": {
    "ios": {
      "associatedDomains": ["applinks:pantryrun.app"],
      "bundleIdentifier": "com.shiftlogichq.pantryrun"
    }
  }
}
```

---

## 3. Android Configuration

### Add Intent Filters

In `AndroidManifest.xml`, add intent filters for both the custom scheme and app links:

```xml
<activity android:name=".MainActivity" ...>

  <!-- Custom URL scheme -->
  <intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="grocceryapp" android:host="invite" />
  </intent-filter>

  <!-- App Links (HTTPS) -->
  <intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="pantryrun.app" android:pathPrefix="/invite" />
  </intent-filter>

</activity>
```

### Alternative: Via `app.json` (Expo)

```json
{
  "expo": {
    "android": {
      "package": "com.shiftlogichq.pantryrun",
      "intentFilters": [
        {
          "action": "VIEW",
          "autoVerify": true,
          "data": [
            {
              "scheme": "grocceryapp",
              "host": "invite",
              "pathPrefix": ""
            },
            {
              "scheme": "https",
              "host": "pantryrun.app",
              "pathPrefix": "/invite"
            }
          ],
          "category": ["BROWSABLE", "DEFAULT"]
        }
      ]
    }
  }
}
```

---

## 4. Web Fallback Page

**File location in repo:** `relay-server/public/invite-redirect.html`

This page is served at `https://relay.example.com/invite?token=...` and:

1. Attempts to open the app via the `grocceryapp://` custom scheme
2. If the app isn't detected within 2 seconds, redirects to the App Store / Google Play
3. Shows a branded button for manual app opening
4. Provides a fallback link to the HTTPS universal link

### Deployment

Serve this file from your relay server's web root. For a simple Express relay server:

```javascript
const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/invite', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invite-redirect.html'));
});
```

### Configuration

Update these values in `<script>` at the bottom of `invite-redirect.html`:

- `iosStoreUrl` — Your App Store URL
- `androidStoreUrl` — Your Google Play URL
- The domain in `storeUrl` detection logic if needed

---

## 5. Testing Deep Links

### iOS Simulator

```bash
# Test custom scheme
xcrun simctl openurl booted "grocceryapp://invite?token=test-token-123"

# Test universal link
xcrun simctl openurl booted "https://pantryrun.app/invite?token=test-token-123"
```

### Android Emulator

```bash
# Test custom scheme
adb shell am start -W -a android.intent.action.VIEW \
  -d "grocceryapp://invite?token=test-token-123"

# Test app link
adb shell am start -W -a android.intent.action.VIEW \
  -d "https://pantryrun.app/invite?token=test-token-123"
```

### Physical Device

1. Send yourself an invite link via the Share Invite button in the app
2. Tap the link in Messages / Email
3. The app should open to the invite handler screen

### Verify Universal Links (iOS)

Apple provides a validation tool. After deployment:

```bash
curl -v https://pantryrun.app/.well-known/apple-app-site-association
```

Or use the [Apple App Site Association Validator](https://search.developer.apple.com/appsearch-validation-tool/) (requires Apple Developer login).

### Verify App Links (Android)

```bash
adb shell dumpsys package domain-preferred-apps
```

Or use the [Statement List Generator and Tester](https://developers.google.com/digital-asset-links/tools/generator).

---

## 6. URL Formats Reference

| Purpose | URL Format |
|---------|-----------|
| Custom scheme invite | `grocceryapp://invite?token=***` |
| Universal link invite | `https://pantryrun.app/invite?token=***` |
| Web fallback | `https://relay.example.com/invite?token=***` |

## 7. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `grocceryapp://` links don't open app | Scheme not registered | Add URL type in Xcode / intent filter in AndroidManifest |
| Universal link shows web page instead of app | AASA file incorrect or not at correct path | Verify apple-app-site-association is served at `/.well-known/` with correct content-type |
| "Cannot Open Page" on iOS | Associated domain not configured | Add `applinks:pantryrun.app` to Associated Domains entitlement |
| Android auto-verify fails | Wrong SHA-256 fingerprint | Regenerate and update assetlinks.json |
| Web fallback doesn't redirect to store | Store URLs not configured | Update `iosStoreUrl` and `androidStoreUrl` in invite-redirect.html |
