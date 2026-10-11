#!/usr/bin/env node
/**
 * Release-configuration regression check (audit findings M5, M7, M8, L11, L12).
 *
 * Run: node plugins/__checks__/release-config.check.js
 *
 * WIRED UP: `npm run check:release` (GroceryApp/package.json), invoked by CI at
 * .github/workflows/ci.yml:104 alongside the jest step. A revert goes red.
 *
 * Deliberately NOT a jest test and deliberately not wired in via jest.config.js:
 * that config pins `roots: ['<rootDir>/__tests__']` AND `testMatch: ['**\/*.test.ts']`,
 * so a .js assert script needs both widened, and this is a config-tree gate rather
 * than a unit test — the npm script is the smaller, more honest hook.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/**
 * Read a file that lives OUTSIDE the app package (the owner-facing docs at the
 * repo root). A bare read would surface a checkout-layout problem as a cryptic
 * ENOENT attributed to content drift, which is a different and much more
 * alarming diagnosis than "that file isn't here".
 */
const readDoc = (p) => {
  const full = path.join(root, p);
  assert(fs.existsSync(full), `${p} not found at ${full} — expected it at the repo root`);
  return fs.readFileSync(full, 'utf8');
};
const readJson = (p) => JSON.parse(read(p));

const checks = [];
const check = (name, fn) => checks.push([name, fn, false]);

/**
 * A finding that is deliberately NOT closed because closing it needs a value or a
 * decision only the repo owner can supply. It asserts the *closed* state, so it
 * turns green by itself the day the owner acts — but a failure prints as
 * PENDING-OWNER and does not fail the run, so the other checks stay a usable gate.
 * Never demote a check here to make it pass; the point is that it stays visible.
 */
const pending = (name, fn) => checks.push([name, fn, true]);

// ── Both config files must be strict, parseable JSON ────────────────────────
check('app.json parses as strict JSON', () => readJson('app.json'));
check('eas.json parses as strict JSON', () => readJson('eas.json'));

// ── M8: the app.json cleartext key is an inert no-op ────────────────────────
// Empirically settled: `usesCleartextTraffic` exists nowhere in @expo/config-types'
// schema and is never read from the config by @expo/config-plugins — it appears only
// as a TypeScript type describing an AndroidManifest XML attribute. Carrying it in
// app.json states an intent nothing enforces, contradicting the manifest that does.
check('M8: app.json carries no inert usesCleartextTraffic key', () => {
  const android = readJson('app.json').expo.android;
  assert.strictEqual(
    android.usesCleartextTraffic,
    undefined,
    'app.json android.usesCleartextTraffic is a no-op key; intent belongs in the config plugin'
  );
  assert.strictEqual(android._usesCleartextTrafficNote, undefined);
});

check('M8: a network-security config plugin is registered in app.json', () => {
  const plugins = readJson('app.json').expo.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
  assert.ok(
    plugins.includes('./plugins/withNetworkSecurityConfig.js'),
    'prebuild must reproduce the committed manifest, not silently drop the cleartext scoping'
  );
});

check('M8: committed res/xml matches the plugin constant byte for byte', () => {
  const { NETWORK_SECURITY_CONFIG_XML, RES_PATH } = require(
    path.join(root, 'plugins/withNetworkSecurityConfig.js')
  );
  assert.strictEqual(
    read(path.join('android', RES_PATH)),
    NETWORK_SECURITY_CONFIG_XML,
    'the committed resource has drifted from the plugin that regenerates it on prebuild'
  );
});

// Byte-equality above proves the two agree; it does not prove they are valid.
// Both were briefly identical AND malformed: an ASCII rule ("------") inside a
// comment is illegal XML, because a comment may not contain a double hyphen.
// aapt2 rejects that at build time, long after this check said everything was
// fine. Parse it here so the gate covers well-formedness, not just agreement.
check('M8: the network-security config is well-formed XML', () => {
  const { NETWORK_SECURITY_CONFIG_XML: xml } = require(
    path.join(root, 'plugins/withNetworkSecurityConfig.js')
  );

  // No double hyphen inside any comment, and no comment ending in a hyphen.
  for (const m of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
    assert.ok(
      !m[1].includes('--'),
      `XML comments may not contain "--": ${m[1].slice(0, 80).trim()}…`
    );
    assert.ok(!m[1].endsWith('-'), 'an XML comment may not end with a hyphen');
  }

  // Tags balance. Deliberately not a full parser — Node ships no XML parser and
  // this file must not take a dependency to check one resource.
  // Comments are stripped first: this file's own prose mentions <application>,
  // and counting that as an open tag is how this check first failed itself.
  const body = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  const tags = [...body.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)];
  const stack = [];
  for (const [, closing, name, selfClosing] of tags) {
    if (selfClosing) continue;
    if (closing) {
      assert.strictEqual(stack.pop(), name, `mismatched closing tag </${name}>`);
    } else {
      stack.push(name);
    }
  }
  assert.strictEqual(stack.length, 0, `unclosed tag(s): ${stack.join(', ')}`);
});

check('M8: the config plugin produces the committed manifest attribute', () => {
  const withNsc = require(path.join(root, 'plugins/withNetworkSecurityConfig.js'));
  assert.strictEqual(typeof withNsc, 'function');
  // Drive the manifest mod the way expo-config-plugins does and confirm it sets the
  // same attribute pair the committed AndroidManifest.xml has.
  const app = { $: { 'android:name': '.MainApplication' } };
  const config = { modResults: { manifest: { application: [app] } } };
  withNsc.setNetworkSecurityConfig(config.modResults);
  assert.strictEqual(app.$['android:networkSecurityConfig'], '@xml/network_security_config');
  assert.strictEqual(app.$['android:usesCleartextTraffic'], undefined);
});

// ── M5: cleartext must be scoped by a network security config ───────────────
check('M5: AndroidManifest no longer enables cleartext app-wide', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.ok(
    !/android:usesCleartextTraffic="true"/.test(manifest),
    'app-wide cleartext is still enabled in the release manifest'
  );
  assert.ok(
    /android:networkSecurityConfig="@xml\/network_security_config"/.test(manifest),
    'manifest does not reference a network security config'
  );
});

check('M5: public API endpoints are pinned to HTTPS', () => {
  const nsc = read('android/app/src/main/res/xml/network_security_config.xml');
  assert.ok(
    /<domain-config[^>]*cleartextTrafficPermitted="false"/.test(nsc),
    'no domain-config denies cleartext; the app gained nothing over the bare attribute'
  );
  for (const host of ['pantryrun.app', 'api.nal.usda.gov', 'openfoodfacts.org']) {
    assert.ok(nsc.includes(`>${host}<`), `public endpoint not pinned to HTTPS: ${host}`);
  }
});

check('M5: iOS keeps the ATS scoping the Android config is meant to mirror', () => {
  const ats = readJson('app.json').expo.ios.infoPlist.NSAppTransportSecurity;
  assert.strictEqual(ats.NSAllowsArbitraryLoads, false, 'iOS ATS must deny arbitrary loads');
  assert.strictEqual(ats.NSAllowsLocalNetworking, true, 'iOS must still permit the LAN relay');
});

pending('M5: Android denies cleartext by default, mirroring iOS ATS', () => {
  // The remaining half of M5. Deliberately red until the owner signs off, because
  // closing it is a breaking change, not a config tweak: docs/self-host-security.md
  // tells self-hosters to connect via bare LAN IP, Android's NSC grammar has no
  // CIDR to exempt RFC1918 with, and RN's WebSocket honours NetworkSecurityPolicy
  // via OkHttp. Land it together with a docs change moving self-hosters to a
  // router-resolvable hostname or wss://; see the comment in the XML itself.
  const nsc = read('android/app/src/main/res/xml/network_security_config.xml');
  assert.ok(
    /<base-config[^>]*cleartextTrafficPermitted="false"/.test(nsc),
    'base-config still permits cleartext app-wide; only the public endpoints are pinned'
  );
});

// ── M7: repeated iOS submissions must get distinct build numbers ────────────
check('M7: production builds auto-increment the build number', () => {
  const eas = readJson('eas.json');
  assert.notStrictEqual(
    eas.build.production.autoIncrement,
    false,
    'autoIncrement:false makes a second iOS submission collide with the first'
  );
  assert.ok(eas.build.production.autoIncrement, 'autoIncrement must be enabled for production');
  // autoIncrement alone is not enough on this project. With appVersionSource
  // "local" and committed native trees, EAS bumps Info.plist/build.gradle inside
  // the build container and the change is discarded unless someone commits it —
  // so the next CI build reuses the same number and the submission still collides.
  // "remote" keeps the counter on EAS servers, which is what makes it monotonic.
  assert.strictEqual(
    eas.cli.appVersionSource,
    'remote',
    'appVersionSource must be "remote" for autoIncrement to survive CI builds'
  );
});

// The last build number actually published to a store. versionCode 31 shipped
// to Play closed testing on 2026-08-08 (see the v1.31.0 release commit). Bump
// this ONLY to a number that has genuinely shipped.
const LAST_SHIPPED_BUILD = 31;

check('M7: the version seed EAS actually reads is intact', () => {
  // Guard the NATIVE values, not app.json. `eas build:version:get` says so
  // outright on this project:
  //
  //   "android.versionCode field in app config is ignored when version source
  //    is set to remote"
  //   "Specified value for android.package in app.json is ignored because an
  //    android directory was detected. EAS Build will use the value found in
  //    the native code."
  //
  // The native trees are committed here, so build.gradle and Info.plist are the
  // real seed; an earlier version of this check pinned app.json, which EAS does
  // not read at all. Getting this wrong means a build that looks fine and is
  // rejected at submission, because Play refuses any versionCode <= the live one.
  const versionCode = Number(/versionCode\s+(\d+)/.exec(read('android/app/build.gradle'))[1]);
  const bundleVersion = Number(
    /<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/.exec(read('ios/PantryRun/Info.plist'))[1]
  );

  assert.ok(
    Number.isInteger(versionCode) && versionCode >= LAST_SHIPPED_BUILD,
    `android/app/build.gradle versionCode ${versionCode} is below the shipped ` +
      `${LAST_SHIPPED_BUILD}; Play rejects a versionCode that is not strictly greater than the live one`
  );
  assert.ok(
    Number.isInteger(bundleVersion) && bundleVersion >= LAST_SHIPPED_BUILD,
    `ios/PantryRun/Info.plist CFBundleVersion ${bundleVersion} is below the shipped ${LAST_SHIPPED_BUILD}`
  );
});

pending('M7: the EAS remote ANDROID version counter is initialised', () => {
  // iOS is DONE. Checked against EAS on 2026-08-08 with an authenticated session:
  // the project had no remote versions at all, and the first `eas build --platform
  // ios` initialised buildNumber from the native value —
  //   "No remote versions are configured for this project, buildNumber will be
  //    initialized based on the value from the local project. Initializing
  //    buildNumber with 31."
  // `build:version:get --platform ios` now reports 31, so the next build is 32.
  //
  // Android has NOT been initialised yet — `build:version:get --platform android`
  // still reports "No remote versions are configured for this project". It will
  // initialise the same proven way from build.gradle's versionCode 31 on the first
  // Android EAS build, which the check above keeps intact. Left PENDING because
  // that has been reasoned, not observed, and Play rejects a versionCode <= 31.
  //
  // Confirm with one command, then delete this entry:
  //   npx eas-cli build:version:get --platform android
  assert.fail(
    `EAS remote Android counter not yet initialised. It should seed from build.gradle at ` +
      `${LAST_SHIPPED_BUILD} on the first Android EAS build (iOS did exactly that). Confirm with ` +
      `\`npx eas-cli build:version:get --platform android\` before submitting.`
  );
});

check('M7: committed iOS build number is not stale against Android', () => {
  // The native trees are committed and not easignored, so EAS builds from them:
  // Info.plist CFBundleVersion is the real iOS build number, app.json ios.buildNumber
  // is inert on this path (same failure mode as M8).
  const infoPlist = read('ios/PantryRun/Info.plist');
  const bundleVersion = /<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/.exec(infoPlist)[1];
  const versionCode = /versionCode\s+(\d+)/.exec(read('android/app/build.gradle'))[1];
  assert.strictEqual(
    bundleVersion,
    versionCode,
    `iOS CFBundleVersion ${bundleVersion} drifted from Android versionCode ${versionCode}`
  );
});

// ── L11: the iOS submit profile must be usable ──────────────────────────────
check('L11: eas.json has an iOS submit profile with both required keys', () => {
  const ios = readJson('eas.json').submit.production.ios;
  assert.ok(ios, 'submit.production has no ios block');
  assert.ok(ios.ascAppId, 'submit.production.ios.ascAppId is missing');
  assert.ok(ios.appleTeamId, 'submit.production.ios.appleTeamId is missing');
});

check('L11: eas.json has an Android submit profile with a key path and a track', () => {
  // `eas submit --platform android` needs both, and an absent android block fails
  // just as hard as the iOS placeholders do — it was simply invisible before.
  const android = readJson('eas.json').submit.production.android;
  assert.ok(android, 'submit.production has no android block');
  assert.ok(
    android.serviceAccountKeyPath,
    'submit.production.android.serviceAccountKeyPath is missing'
  );
  assert.ok(
    ['internal', 'alpha', 'beta', 'production'].includes(android.track),
    `submit.production.android.track must be an explicit Play track, got ${android.track}`
  );
});

pending('L11: the Play service-account key path is gitignored', () => {
  // The key is a Google service-account JSON with upload rights to the Play
  // listing; it must never be committed. Neither .gitignore is inside this work
  // item's owned paths, so the rule cannot be added from here — hence pending.
  // Substring match on the file text, not `git check-ignore`: no git commands.
  const dir = `${path.dirname(readJson('eas.json').submit.production.android.serviceAccountKeyPath)}/`
    .replace(/^\.\//, '');
  const ignores = [read('.gitignore'), read('../.gitignore')].join('\n');
  assert.ok(
    ignores.split('\n').some((line) => line.trim().replace(/^GroceryApp\//, '') === dir),
    `no .gitignore rule covers ${dir}; the Play service-account key can be committed by accident`
  );
});

pending('L11: the Play service-account key is actually present', () => {
  // Shape-only checks are how L11 stayed invisible the first time: a path that
  // points at nothing passes every structural assertion while
  // `eas submit --platform android` still fails. This is expected to print on a
  // fresh checkout — the key is provisioned, never committed — but it belongs in
  // the outstanding list so "0 failed" is never read as "ready to submit".
  const p = readJson('eas.json').submit.production.android.serviceAccountKeyPath;
  assert.ok(
    fs.existsSync(path.join(root, p)),
    `Play service-account JSON not present at ${p}; provision it before submitting`
  );
});

pending('L11: the iOS submit profile carries real IDs, not placeholders', () => {
  // The shape is right but the values are not fillable from here — an App Store
  // Connect app ID and an Apple team ID are account-specific and must not be
  // invented. `eas submit --platform ios --profile production` fails until the
  // owner replaces both, so this stays visibly pending rather than green.
  const ios = readJson('eas.json').submit.production.ios;
  assert.ok(!/^REPLACE_WITH_/.test(ios.ascAppId), 'ascAppId is still the placeholder');
  assert.ok(!/^REPLACE_WITH_/.test(ios.appleTeamId), 'appleTeamId is still the placeholder');
});

// ── L12: release pushes must target the production APNs environment ─────────
check('L12: release entitlements use the production APNs environment', () => {
  const ent = read('ios/PantryRun/PantryRun.entitlements');
  // Tolerate an explanatory <!-- --> comment between the key and its value.
  const after = ent.slice(ent.indexOf('<key>aps-environment</key>'));
  const apsEnv = /<string>([^<]*)<\/string>/.exec(after)[1];
  assert.strictEqual(
    apsEnv,
    'production',
    'a release build with aps-environment=development registers against the APNs sandbox'
  );
});

check('L12: Debug signs against a separate entitlements file using the APNs sandbox', () => {
  // aps-environment must differ per configuration. A Development provisioning
  // profile — which `eas build --profile development` and `expo run:ios` both
  // use — carries aps-environment=development, so pointing Debug at the release
  // entitlements makes the entitlement disagree with the profile and the build
  // fails to sign. One shared file cannot express both; hence two.
  const pbx = read('ios/PantryRun.xcodeproj/project.pbxproj');
  // Pair each XCBuildConfiguration that sets CODE_SIGN_ENTITLEMENTS with its own
  // trailing `name = X;`. Keyed off structure, not UUIDs, so it survives an Xcode
  // rewrite — and it skips the project-level Debug/Release blocks, which set no
  // entitlements at all.
  const paths = {};
  const re = /CODE_SIGN_ENTITLEMENTS = ([^;]+);[\s\S]*?\n\t\t\tname = (\w+);/g;
  for (let m; (m = re.exec(pbx)); ) paths[m[2]] = m[1].trim();
  assert.ok(paths.Debug && paths.Release, 'no per-configuration CODE_SIGN_ENTITLEMENTS found');
  assert.notStrictEqual(
    paths.Debug,
    paths.Release,
    `Debug and Release share ${paths.Release}; flipping it to production breaks dev signing`
  );
  const debugEnt = read(path.join('ios', paths.Debug));
  const after = debugEnt.slice(debugEnt.indexOf('<key>aps-environment</key>'));
  assert.strictEqual(
    /<string>([^<]*)<\/string>/.exec(after)[1],
    'development',
    'the Debug entitlements must keep the APNs sandbox environment'
  );
});

// ── N1: the Play base plan ID in code must match what the owner is told ─────
// The shipped "SKU not found" outage was a client that sent an empty offerToken
// because the handoff doc said Play resolves the offer itself. It does not.
// Now that PLUS_BASE_PLAN_ID is matched exactly against the Console, the doc and
// the constant drifting apart silently breaks 100% of Android purchases — and
// the owner creates the product FROM the doc, so the doc is the live config.
check('N1: the handoff names the exact base plan ID the code matches on', () => {
  const src = read('src/config/entitlements.ts');
  const m = src.match(/PLUS_BASE_PLAN_ID\s*=\s*'([^']+)'/);
  assert(m, 'PLUS_BASE_PLAN_ID not found in src/config/entitlements.ts');
  const handoff = readDoc('../audit-package/08-SUBMISSION-HANDOFF.md');
  // Match the "Base plan ID" table ROW, not the whole file. A bare substring
  // search passes on any ID the doc merely mentions — and the doc lists several
  // WRONG names as cautionary examples, so a code-only rename to one of those
  // slipped straight through the first version of this check.
  const row = handoff.split('\n').find((l) => /^\|\s*Base plan ID\s*\|/.test(l));
  assert(row, '08-SUBMISSION-HANDOFF.md has no "Base plan ID" row for the Play product');
  assert(
    row.includes(`\`${m[1]}\``),
    `08-SUBMISSION-HANDOFF.md's Base plan ID row does not name \`${m[1]}\` ` +
      `(row reads: ${row.trim().slice(0, 100)}). The owner creates the Play product ` +
      'from this row, so a mismatch fails 100% of Android purchases.'
  );
});

check('N1: no doc still claims Play resolves the offer without a token', () => {
  for (const f of ['../audit-package/08-SUBMISSION-HANDOFF.md', '../GOAL_PROMPT_NOTES.md']) {
    const body = readDoc(f);
    // The retraction quotes the false claim on purpose, so only flag it when it
    // appears as live instruction rather than inside the correction.
    const live = body
      .split('\n')
      .filter((l) => /empty offerToken/.test(l) && !/was false|is false|earlier/i.test(l));
    assert.strictEqual(
      live.length, 0,
      `${f} still instructs the empty-offerToken mechanism, which Play rejects:\n` +
        live.map((l) => '    ' + l.trim().slice(0, 120)).join('\n')
    );
  }
});

// ── Store readiness: launch screen, purpose strings, link hosts ─────────────
check('S1: every image the launch storyboard names exists in Images.xcassets', () => {
  // A storyboard image name with no matching imageset renders a blank launch
  // screen — it shipped that way once ("SplashScreen" vs "SplashScreenLogo").
  const sb = read('ios/PantryRun/SplashScreen.storyboard');
  // <imageView … image="X"> references plus <resources><image name="X">
  // declarations (accessibilityTraits also has an image="YES" attribute).
  const names = new Set([
    ...[...sb.matchAll(/<imageView\b[^>]*\bimage="([^"]+)"/g)].map((m) => m[1]),
    ...[...sb.matchAll(/<image name="([^"]+)"/g)].map((m) => m[1]),
  ]);
  assert.ok(names.size > 0, 'launch storyboard shows no image at all');
  for (const name of names) {
    const dir = path.join(root, 'ios/PantryRun/Images.xcassets', `${name}.imageset`);
    assert.ok(fs.existsSync(path.join(dir, 'Contents.json')), `no ${name}.imageset in Images.xcassets`);
    const { images } = JSON.parse(fs.readFileSync(path.join(dir, 'Contents.json'), 'utf8'));
    for (const img of images.filter((i) => i.filename)) {
      assert.ok(fs.existsSync(path.join(dir, img.filename)), `${name}.imageset is missing ${img.filename}`);
    }
  }
});

check('S2: iOS carries a microphone purpose string (expo-camera links audio APIs)', () => {
  const plist = read('ios/PantryRun/Info.plist');
  assert.ok(
    /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/.test(plist),
    'Info.plist has no NSMicrophoneUsageDescription; App Store processing rejects binaries that link microphone APIs without one'
  );
  assert.ok(readJson('app.json').expo.ios.infoPlist.NSMicrophoneUsageDescription, 'app.json lost the microphone purpose string');
});

check('S3: universal/app link hosts agree across entitlements, manifest, app.json and code', () => {
  const HOSTS = ['pantryrun.app', 'www.pantryrun.app'];
  const app = readJson('app.json').expo;
  for (const f of ['ios/PantryRun/PantryRun.entitlements', 'ios/PantryRun/PantryRunDebug.entitlements']) {
    const domains = [...read(f).matchAll(/<string>applinks:([^<]+)<\/string>/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(domains, [...HOSTS].sort(), `${f} applinks drifted: ${domains.join(', ')}`);
  }
  assert.deepStrictEqual(app.ios.associatedDomains.slice().sort(), HOSTS.map((h) => `applinks:${h}`).sort());
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const verified = manifest.slice(manifest.indexOf('android:autoVerify="true"'));
  const block = verified.slice(0, verified.indexOf('</intent-filter>'));
  const manifestHosts = [...block.matchAll(/android:host="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(manifestHosts, [...HOSTS].sort(), `autoVerify hosts drifted: ${manifestHosts.join(', ')}`);
  const appJsonHosts = app.android.intentFilters
    .filter((f) => f.autoVerify)
    .flatMap((f) => f.data.map((d) => d.host))
    .sort();
  assert.deepStrictEqual(appJsonHosts, [...HOSTS].sort());
  const deepLinks = read('src/navigation/deepLinks.ts');
  for (const h of HOSTS) assert.ok(deepLinks.includes(`'https://${h}'`), `deepLinks.ts prefixes miss https://${h}`);
  // groceryapp.app never existed (NXDOMAIN); it must not creep back into config.
  for (const f of ['app.json', 'android/app/src/main/AndroidManifest.xml', 'ios/PantryRun/PantryRun.entitlements', 'src/navigation/deepLinks.ts']) {
    assert.ok(!read(f).includes('groceryapp.app'), `${f} still references groceryapp.app`);
  }
});

check('S4: the custom invite scheme old builds generate is still registered', () => {
  // Every shipped build writes groceryapp://invite links; dropping the scheme
  // would kill every outstanding invite.
  assert.ok(/<string>groceryapp<\/string>/.test(read('ios/PantryRun/Info.plist')), 'iOS lost the groceryapp scheme');
  assert.ok(/android:scheme="groceryapp"/.test(read('android/app/src/main/AndroidManifest.xml')), 'Android lost the groceryapp scheme');
});

check('S6: Android backup and device transfer are off, and prebuild reproduces it', () => {
  // Restored SecureStore values / DB rows are undecryptable on a new device
  // (the Keystore key does not move), so the app opts out entirely.
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.ok(/android:allowBackup="false"/.test(manifest), 'manifest allows Auto Backup');
  assert.ok(
    /android:dataExtractionRules="@xml\/data_extraction_rules"/.test(manifest),
    'Android 12+ still does device-to-device transfer without dataExtractionRules'
  );
  const plugin = require(path.join(root, 'plugins/withAndroidBackupRules.js'));
  assert.strictEqual(read(path.join('android', plugin.RES_PATH)), plugin.DATA_EXTRACTION_RULES_XML,
    'committed data_extraction_rules.xml drifted from the plugin that regenerates it');
  for (const section of ['cloud-backup', 'device-transfer']) {
    const block = plugin.DATA_EXTRACTION_RULES_XML.split(`<${section}>`)[1].split(`</${section}>`)[0];
    for (const d of ['database', 'sharedpref']) {
      assert.ok(block.includes(`<exclude domain="${d}" path="." />`), `${section} does not exclude ${d}`);
    }
    assert.ok(!block.includes('<include'), `${section} re-includes something`);
  }
  const plugins = readJson('app.json').expo.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
  assert.ok(plugins.includes('./plugins/withAndroidBackupRules.js'), 'backup-rules plugin not registered');
  assert.strictEqual(readJson('app.json').expo.android.allowBackup, false);
  const app = { $: { 'android:name': '.MainApplication', 'android:allowBackup': 'true' } };
  plugin.setBackupRules({ manifest: { application: [app] } });
  assert.strictEqual(app.$['android:allowBackup'], 'false');
});

check('S7: one marketing version everywhere (package.json, app.json, native trees)', () => {
  const pkg = readJson('package.json').version;
  const app = readJson('app.json').expo.version;
  const gradle = /versionName\s+"([^"]+)"/.exec(read('android/app/build.gradle'))[1];
  const plist = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(
    read('ios/PantryRun/Info.plist')
  )[1];
  assert.deepStrictEqual(
    { pkg, gradle, plist },
    { pkg: app, gradle: app, plist: app },
    `version drift: package.json ${pkg}, app.json ${app}, build.gradle ${gradle}, Info.plist ${plist}`
  );
});

pending('S5: hosted association files carry real IDs, not placeholders', () => {
  // site/.well-known/* are the ready-to-host copies for the pantryrun-site Worker.
  // Universal / app links cannot verify until the owner fills these in.
  const aasa = readDoc('../site/.well-known/apple-app-site-association');
  const links = readDoc('../site/.well-known/assetlinks.json');
  assert.ok(!aasa.includes('TEAMID.'), 'apple-app-site-association still has the TEAMID placeholder');
  assert.ok(!links.includes('REPLACE_WITH_'), 'assetlinks.json still has the SHA-256 placeholder');
});

let failed = 0;
const outstanding = [];
for (const [name, fn, isPending] of checks) {
  try {
    fn();
    console.log(`  ok      ${name}`);
  } catch (err) {
    if (isPending) {
      outstanding.push(`${name} — ${err.message}`);
      console.log(`  PENDING ${name}\n            owner action: ${err.message}`);
    } else {
      failed++;
      console.log(`  FAIL    ${name}\n            ${err.message}`);
    }
  }
}
console.log(
  `\n${checks.length - failed - outstanding.length}/${checks.length} passed, ` +
    `${outstanding.length} pending owner action, ${failed} failed`
);
// A green run means "no regressions", NOT "ready to ship". Say so loudly: the
// pending items are release *preconditions*, and a summary that only counts
// passes reads as submittable when neither store submission would actually work.
if (outstanding.length) {
  console.log(`\nNOT SUBMITTABLE: ${outstanding.length} owner action(s) outstanding`);
  outstanding.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
}
// Exit code tracks regressions only — owner preconditions must not wedge CI.
process.exit(failed ? 1 : 0);
