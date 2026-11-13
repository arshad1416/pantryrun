#!/usr/bin/env bash
# Validate offline side-by-side QA isolation before installing. No production writes.
set -euo pipefail
apk="${1:-android/app/build/outputs/apk/qa/app-qa.apk}"
sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
aapt="$(find "$sdk/build-tools" -name aapt -type f | sort | tail -1)"
test -n "$aapt"
badging="$($aapt dump badging "$apk")"
grep -q "package: name='com.shiftlogichq.pantryrun.qa'" <<< "$badging"
permissions="$($aapt dump permissions "$apk")"
if grep -Eq 'android.permission.INTERNET|com.android.vending.BILLING' <<< "$permissions"; then
  echo 'Unsafe QA APK: network or purchase permission present' >&2; exit 1
fi
manifest="$($aapt dump xmltree "$apk" AndroidManifest.xml | sed -n '/E: application/,$p')"
if grep -Eq 'android.intent.category.BROWSABLE|android:autoVerify' <<< "$manifest"; then
  echo 'Unsafe QA APK: external/deep-link intent present' >&2; exit 1
fi
printf 'QA isolation verified: separate package, no INTERNET/BILLING, no deep links.\n'
