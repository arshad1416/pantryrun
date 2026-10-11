# Universal / App Links — Hosting Checklist

Invite links (`https://pantryrun.app/invite?token=…`, and the same on
`www.pantryrun.app`) only open the app directly (no browser chooser) if BOTH
association files are hosted on BOTH hosts. Custom-scheme links
(`groceryapp://invite?token=…` — what the app generates today, so invites from
every shipped build keep working — and the newer `pantryrun://` alias) work
without any hosting.

`groceryapp.app` was the old placeholder host. It was never registered
(NXDOMAIN), so universal links could never have verified; everything now points
at `pantryrun.app`.

## Which hosts

| Where | Value |
|---|---|
| iOS entitlements (Release + Debug) | `applinks:pantryrun.app`, `applinks:www.pantryrun.app` |
| Android autoVerify intent filter | `https://pantryrun.app/invite`, `https://www.pantryrun.app/invite` |
| `src/navigation/deepLinks.ts` prefixes | `groceryapp://`, `pantryrun://`, `https://pantryrun.app`, `https://www.pantryrun.app` |
| HTTPS invite builder (`INVITE_LINK_HOST`) | `https://pantryrun.app` |

Both hosts are served today by the `pantryrun-site` Cloudflare Worker, with no
redirect between them — that is why both are listed. If you ever make one
redirect to the other, Apple will not follow a redirect for the association
file, so keep serving `/.well-known/*` directly on both.

## Files

Ready-to-host copies (no `_comment` key) live in `site/.well-known/` at the repo
root; deploy steps are in `site/README.md`. The commented templates stay here:

| Platform | Template | Ready-to-host copy | Deploy path (both hosts) | Fill in before deploy |
|----------|----------|--------------------|--------------------------|-----------------------|
| iOS | `ios/apple-app-site-association` | `site/.well-known/apple-app-site-association` | `/.well-known/apple-app-site-association` | Replace `TEAMID` with your Apple Team ID |
| Android | `android/assetlinks.json` | `site/.well-known/assetlinks.json` | `/.well-known/assetlinks.json` | Replace the fingerprint with your app signing cert's SHA-256 |

Notes:
- Serve as `Content-Type: application/json`, over HTTPS, with NO redirects.
  The iOS file has **no** `.json` extension.
- Android: if you use Google Play App Signing (recommended), use the SHA-256
  from Play Console → App integrity → *App signing key certificate* (NOT just
  the upload key), otherwise verified links fail once Play re-signs.
- Verify after deploy:
  - `curl -sI https://pantryrun.app/.well-known/apple-app-site-association` and
    the same for `www.` and for `assetlinks.json` — expect `200` and
    `content-type: application/json`.
  - Android: `adb shell pm verify-app-links --re-verify com.shiftlogichq.pantryrun`
    then `adb shell pm get-app-links com.shiftlogichq.pantryrun` (both hosts
    should read `verified`).
  - iOS: install a TestFlight build and tap an `https://pantryrun.app/invite?…`
    link; it should open PantryRun's Pairing screen. Apple caches the file via
    its CDN, so a fix can take a while to show up.
- `site/invite/index.html` is a fallback page for `/invite` when the app is not
  installed (or the link was opened in a browser): it hands the token to the
  app via `groceryapp://` and otherwise points at the stores.
- In-app routing is already wired: the `invite` path is an alias of the
  `Pairing` screen (`src/navigation/deepLinks.ts`), which reads `token` and
  runs the full join flow.
