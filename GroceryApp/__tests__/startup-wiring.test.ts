/**
 * Startup and screen wiring regressions.
 *
 * 1. src/error-handler.ts was imported by nothing, so neither its global
 *    error handler nor its webcrypto globals ever ran. Wiring it in as-is
 *    would have swallowed fatal errors (it replaced React Native's handler
 *    without chaining), flipped DOM detection with a `document` stub, and
 *    blocked isomorphic-webcrypto's install with an empty `window.crypto`.
 * 2. GroceryListScreen's claim sweep released claims in the Yjs doc but never
 *    refreshed the store the screen renders, so expired claims stayed shown.
 * 3. PairingScreen saved the inviter's single-use invite as this device's
 *    pairingCode, which Settings then offered as "Scan to join your family".
 *
 * Screens are .tsx and there is no RN renderer in this suite, so 2 and 3 are
 * pinned statically, as elsewhere in this suite.
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('error-handler.ts', () => {
  const g = globalThis as any;
  const saved = { ErrorUtils: g.ErrorUtils, window: g.window, document: g.document,
    crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto') };

  afterEach(() => {
    g.ErrorUtils = saved.ErrorUtils;
    g.window = saved.window;
    g.document = saved.document;
    if (saved.crypto) Object.defineProperty(globalThis, 'crypto', saved.crypto);
    jest.restoreAllMocks();
  });

  function load(): { installed: (e: any, fatal?: boolean) => void; previous: jest.Mock } {
    const previous = jest.fn();
    let installed: any = null;
    g.ErrorUtils = { getGlobalHandler: () => previous, setGlobalHandler: (h: any) => { installed = h; } };
    delete g.window;
    delete g.document;
    jest.isolateModules(() => { require('../src/error-handler'); });
    return { installed, previous };
  }

  it('chains to the handler React Native installed, fatal flag included', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { installed, previous } = load();
    const err = new Error('boom');
    installed(err, true);
    expect(previous).toHaveBeenCalledWith(err, true);
  });

  it('does not define document (lib0 isBrowser would turn true)', () => {
    load();
    expect(typeof g.document).toBe('undefined');
  });

  it('leaves window.crypto unset without a native crypto, so the polyfill can install', () => {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    load();
    expect(g.window.crypto).toBeUndefined();
  });

  it('is the first import of the entry point', () => {
    const imports = read('index.ts').match(/^import .*$/gm) ?? [];
    expect(imports[0]).toBe("import './src/error-handler';");
  });
});

describe('screen wiring', () => {
  it('the claim sweep refreshes the visible items when it released any', () => {
    expect(read('src/screens/GroceryListScreen.tsx')).toMatch(
      /if \(yjsSweepExpiredClaims\(listId\) > 0\) loadItems\(listId\)/,
    );
  });

  it("joining with a family invite does not save the inviter's invite as our pairing code", () => {
    const src = read('src/screens/PairingScreen.tsx');
    expect(src).not.toMatch(/^\s*pairingCode: tokenStr,?\s*$/m);
    expect(src).toMatch(/\.\.\.\(invite \? \{\} : \{ pairingCode: tokenStr \}\)/);
  });
});
