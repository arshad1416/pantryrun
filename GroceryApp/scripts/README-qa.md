# Offline Android QA build

Build with `cd android && ./gradlew :app:assembleQa -PreactNativeArchitectures=arm64-v8a`.
Then from GroceryApp run `scripts/check-qa-apk.sh` **before** installing the APK.

The `qa` build is release-like (embedded JS, no Metro required), debug-key signed,
and uses `com.shiftlogichq.pantryrun.qa`, separate from the installed production
app and its encrypted database/keys. Android removes INTERNET and BILLING
permissions from the QA manifest. Its activity has no production deep links.
Use synthetic lists only. Never import an actual recovery phrase or enroll a
live family. Do not install the ordinary debug/release build over the user's app.

This variant intentionally cannot validate online sync, server pricing, cloud
image processing, purchases, telemetry, or enrollment. Those require mocked or
authorized staging services and a separately scoped test pass. Permission
removal is a hard stop on networking, not proof those features work offline.

Do not run Android Monkey on a personal phone, even with `-p`: it filters
activity launches but does not confine injected touch coordinates to the app.
It can open the notification shade and toggle system settings. Use it only on
a disposable emulator. Physical-device interaction tests must use verified
app controls and must stop if SystemUI, another app, or a permission dialog
becomes foreground. Never grant personal camera, photo, location, or contacts
access for this test.

This variant is not a production release, store submission, or production-mode
switch. Normal debug/release configuration remains unchanged.
