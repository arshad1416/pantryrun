/**
 * Tier posture — regression tests.
 *
 * v1 shipped fully free with no in-app purchase (Apple 3.1.1: a visible paid
 * feature with no IAP path is a rejection magnet). PantryRun Plus (Goal 7)
 * deliberately changed the Trip Optimizer posture: the feature now ships ON
 * behind a real, purchasable entitlement. Pins:
 *  - TRIP_OPTIMIZER_ENABLED = true in GroceryListScreen.tsx, and the single
 *    <StopOptimizer render site sits directly inside a
 *    {TRIP_OPTIMIZER_ENABLED && isPlus && ( … )} guard — flag AND paid.
 *  - <TripPlanSheet renders only inside StopOptimizer.tsx, so gating
 *    StopOptimizer gates the whole paid surface transitively.
 *  - Entitlement state is computed ONLY by src/config/entitlements.ts:
 *    react-native-iap appears nowhere else in src/, and the store is
 *    created exactly once, there.
 *  - MANAGED_TIER_ENABLED and VOICE_ASSISTANT_LINKING_ENABLED remain false
 *    (the un-buyable subscription-key field must NOT ship next to the IAP
 *    flow — two purchase paths, one dead, is the original 3.1.1 risk), and
 *    the "Managed Subscription" block stays behind {!isSelfHosted && (.
 *
 * Source-scanning idiom follows turso-gated-off.test.ts / ac15-no-analytics:
 * read the real source text, assert on it. The guard matcher is first proven
 * to discriminate against inline fixtures (one guarded, one unguarded) before
 * being applied to the real files — never by flipping the flag in the tree.
 *
 * Run: npx jest __tests__/free-tier-posture.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const APP_ROOT = path.resolve(__dirname, '..');

/** Recursively collect every file under a directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');
}

/**
 * True iff every occurrence of `<Component` in `source` is immediately
 * preceded (ignoring whitespace) by the given guard opener — i.e. the render
 * site sits directly inside the guard. Returns false when the component never
 * appears, so a deleted render site fails loudly instead of passing silently.
 */
function everyRenderSiteGuarded(
  source: string,
  componentJsx: string,
  guard: string,
): boolean {
  let idx = source.indexOf(componentJsx);
  if (idx === -1) return false;
  while (idx !== -1) {
    const before = source.slice(0, idx).replace(/\s+$/, '');
    if (!before.endsWith(guard)) return false;
    idx = source.indexOf(componentJsx, idx + componentJsx.length);
  }
  return true;
}

// ─── Matcher self-test: prove it discriminates before trusting it ───────────

describe('guard matcher discriminates guarded from unguarded render sites', () => {
  const GUARDED_FIXTURE = `
        <View>
          {TRIP_OPTIMIZER_ENABLED && isPlus && (
            <StopOptimizer items={items} />
          )}
        </View>`;

  const UNGUARDED_FIXTURE = `
        <View>
          <StopOptimizer items={items} />
        </View>`;

  const PLUS_GUARD = '{TRIP_OPTIMIZER_ENABLED && isPlus && (';

  it('accepts a render site directly inside the entitlement guard', () => {
    expect(
      everyRenderSiteGuarded(GUARDED_FIXTURE, '<StopOptimizer', PLUS_GUARD),
    ).toBe(true);
  });

  it('rejects an unguarded render site', () => {
    expect(
      everyRenderSiteGuarded(UNGUARDED_FIXTURE, '<StopOptimizer', PLUS_GUARD),
    ).toBe(false);
  });

  it('rejects a flag-only guard that forgot the entitlement', () => {
    const flagOnly = `
        <View>
          {TRIP_OPTIMIZER_ENABLED && (
            <StopOptimizer items={items} />
          )}
        </View>`;
    expect(
      everyRenderSiteGuarded(flagOnly, '<StopOptimizer', PLUS_GUARD),
    ).toBe(false);
  });

  it('rejects when the render site is absent entirely', () => {
    expect(
      everyRenderSiteGuarded('<View />', '<StopOptimizer', PLUS_GUARD),
    ).toBe(false);
  });
});

// ─── Trip Optimizer ships behind the Plus entitlement ─────────────────────────────────────────────

describe('Trip Optimizer ships ON behind the Plus entitlement', () => {
  const listScreen = read('src/screens/GroceryListScreen.tsx');

  it('TRIP_OPTIMIZER_ENABLED is declared true at module level', () => {
    expect(listScreen).toMatch(/^const TRIP_OPTIMIZER_ENABLED = true;$/m);
  });

  it('every <StopOptimizer render site sits inside the flag AND entitlement guard', () => {
    expect(
      everyRenderSiteGuarded(
        listScreen,
        '<StopOptimizer',
        '{TRIP_OPTIMIZER_ENABLED && isPlus && (',
      ),
    ).toBe(true);
  });

  it('isPlus in GroceryListScreen comes from the entitlement module', () => {
    expect(listScreen).toMatch(
      /const isPlus = useEntitlementStore\(\(s\) => s\.isPlus\);/,
    );
    expect(listScreen).toContain("from '../config/entitlements'");
  });

  it('<StopOptimizer renders only in GroceryListScreen.tsx', () => {
    const offenders = walk(path.join(APP_ROOT, 'src'))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('<StopOptimizer'))
      .map((f) => path.relative(APP_ROOT, f));
    expect(offenders).toEqual(['src/screens/GroceryListScreen.tsx']);
  });

  it('<TripPlanSheet renders only inside StopOptimizer.tsx (unreachable transitively)', () => {
    const offenders = walk(path.join(APP_ROOT, 'src'))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('<TripPlanSheet'))
      .map((f) => path.relative(APP_ROOT, f));
    expect(offenders).toEqual(['src/components/StopOptimizer.tsx']);
  });

  it('no second guard leaked into StopOptimizer.tsx', () => {
    const stopOptimizer = read('src/components/StopOptimizer.tsx');
    expect(stopOptimizer).not.toContain('TRIP_OPTIMIZER_ENABLED');
    expect(stopOptimizer).not.toContain('isPlus');
  });

  it('the implementation and its tests are kept, not deleted', () => {
    for (const rel of [
      'src/pricing/basket-planner.ts',
      'src/components/StopOptimizer.tsx',
      'src/components/TripPlanSheet.tsx',
      '__tests__/basket-planner.test.ts',
      '__tests__/planner-oracle.test.ts',
    ]) {
      expect(fs.existsSync(path.join(APP_ROOT, rel))).toBe(true);
    }
  });
});

// ─── Entitlement single-source invariant ────────────────────────────────

describe('only src/config/entitlements.ts computes entitlement state', () => {
  const srcFiles = walk(path.join(APP_ROOT, 'src')).map((f) => ({
    rel: path.relative(APP_ROOT, f),
    text: fs.readFileSync(f, 'utf8'),
  }));

  it('react-native-iap is imported nowhere else in src/', () => {
    // Match real import forms (static import, dynamic import(), require) —
    // not prose mentions in comments.
    const importRe = /(?:from\s+['"]react-native-iap['"]|import\(['"]react-native-iap['"]\)|require\(['"]react-native-iap['"]\))/;
    const offenders = srcFiles
      .filter(({ text }) => importRe.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual(['src/config/entitlements.ts']);
  });

  it('the entitlement store is created exactly once, in entitlements.ts', () => {
    const offenders = srcFiles
      .filter(({ text }) => text.includes('create<EntitlementState>'))
      .map(({ rel }) => rel);
    expect(offenders).toEqual(['src/config/entitlements.ts']);
  });

  it('no other file touches the entitlements table', () => {
    const offenders = srcFiles
      .filter(
        ({ rel, text }) =>
          rel !== 'src/config/entitlements.ts' &&
          !rel.startsWith('src/storage/') && // schema/model/database declare it
          text.includes("'entitlements'"),
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});

// ─── Managed tier and voice linking stay off ─────────────────────────────────

describe('no other paid or cloud surface is reachable', () => {
  const settingsScreen = read('src/screens/SettingsScreen.tsx');

  it('MANAGED_TIER_ENABLED is false', () => {
    expect(settingsScreen).toMatch(/^const MANAGED_TIER_ENABLED = false;$/m);
  });

  it('VOICE_ASSISTANT_LINKING_ENABLED is false', () => {
    expect(settingsScreen).toMatch(/^const VOICE_ASSISTANT_LINKING_ENABLED = false;$/m);
  });

  it('isSelfHosted is unconditionally true while the flag is false', () => {
    // isSelfHosted = !MANAGED_TIER_ENABLED || …  →  !false || … → true, so the
    // "Managed Subscription" block behind {!isSelfHosted && ( can never render.
    expect(settingsScreen).toContain(
      "const isSelfHosted = !MANAGED_TIER_ENABLED || settings.hostingTier === 'self_hosted';",
    );
  });

  it('the "Managed Subscription" section stays behind {!isSelfHosted && (', () => {
    const titleIdx = settingsScreen.indexOf('>Managed Subscription<');
    expect(titleIdx).toBeGreaterThan(-1);
    // The nearest guard opening before the title must be the !isSelfHosted one.
    const before = settingsScreen.slice(0, titleIdx);
    const guardIdx = before.lastIndexOf('{!isSelfHosted && (');
    expect(guardIdx).toBeGreaterThan(-1);
    // No other JSX conditional-block opener between the guard and the title —
    // i.e. the title lives directly inside that guarded block.
    const between = settingsScreen.slice(guardIdx + '{!isSelfHosted && ('.length, titleIdx);
    expect(between).not.toMatch(/\{\s*!?\w+(\.\w+)*\s*&&\s*\(/);
  });
});
