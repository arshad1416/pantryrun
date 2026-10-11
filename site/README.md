# site/ — files for the `pantryrun-site` Worker (www.pantryrun.app)

Ready-to-host pages and app-link association files for the Cloudflare Worker that
serves `pantryrun.app` and `www.pantryrun.app`. The Worker's own source is not in
this repo, so nothing here deploys by itself: copy these into the Worker's static
assets (or its routes) and deploy it.

The pages use the live site's template and link `/assets/site.css`, which the
Worker already serves, so they match `/privacy` and `/terms` exactly.

| File here | Serve at (on BOTH `pantryrun.app` and `www.pantryrun.app`) | Content-Type | Before deploying |
|---|---|---|---|
| `support/index.html` | `/support` | `text/html` | — (uses `support@pantryrun.app` / `privacy@pantryrun.app`, as the live home page does; make sure both mailboxes receive mail) |
| `privacy/index.html` | `/privacy` (replaces the 30 July 2026 version) | `text/html` | Read §7 and §13: they describe both flyer-extraction options (own-hardware Ollama or Alibaba Cloud Qwen) and the relay's current home (Pi in Ontario via Cloudflare). If you settle on one, tighten the text; if the relay moves (Oracle Cloud), name the provider and region in §13. |
| `invite/index.html` | `/invite` (query string preserved) | `text/html` | Replace `idREPLACE_WITH_APP_STORE_ID` with the numeric App Store ID once the listing exists |
| `.well-known/apple-app-site-association` | `/.well-known/apple-app-site-association` (no extension, no redirect) | `application/json` | Replace `TEAMID` with your 10-character Apple Team ID |
| `.well-known/assetlinks.json` | `/.well-known/assetlinks.json` (no redirect) | `application/json` | Replace the placeholder with the SHA-256 of the **app signing** certificate (Play Console → App integrity → App signing key certificate) |

Also update the home page: its nav and footer link to `/#support`; point them at
`/support`.

## Why both hosts

The iOS entitlements list `applinks:pantryrun.app` and `applinks:www.pantryrun.app`,
and the Android `autoVerify` filter lists both hosts. Apple fetches the association
file from each listed domain and does **not** follow redirects for it; Android
verifies every host in the filter. So `/.well-known/*` must return `200` with JSON
directly on both, even if you later redirect other pages from one host to the other.

## Worker notes

- If the Worker serves static assets, a file without an extension
  (`apple-app-site-association`) may be sent as `application/octet-stream`. Set
  `Content-Type: application/json` for `/.well-known/*` explicitly, for example
  with a `_headers` file:

  ```
  /.well-known/*
    Content-Type: application/json
    Cache-Control: public, max-age=3600
  ```

- `/invite?token=…` carries a one-time family invite in the query string. Once
  universal/app links verify, phones open the app without ever requesting this
  page; until then (or on desktop) the Worker receives the token. Don't log query
  strings for `/invite`, and keep the page `noindex` (it already sets
  `no-referrer`). The invite alone is not enough to read a family's lists — the
  recovery phrase is also required — but treat it as sensitive.

## Verify after deploying

```sh
for h in pantryrun.app www.pantryrun.app; do
  curl -sI "https://$h/.well-known/apple-app-site-association" | grep -iE '^(HTTP|content-type)'
  curl -sI "https://$h/.well-known/assetlinks.json"            | grep -iE '^(HTTP|content-type)'
  curl -s  -o /dev/null -w "%{http_code} /support\n" "https://$h/support"
done
```

Expect `200` and `application/json` for both association files on both hosts.
Then, on devices:

- Android: `adb shell pm verify-app-links --re-verify com.shiftlogichq.pantryrun`
  and `adb shell pm get-app-links com.shiftlogichq.pantryrun` (both hosts
  `verified`).
- iOS: install a TestFlight build and tap an `https://pantryrun.app/invite?token=…`
  link from Notes or Messages; it should open PantryRun's Pairing screen.

More background: `GroceryApp/docs/DEEP-LINK-HOSTING.md`.
