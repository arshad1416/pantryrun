// ─── Global Error Handler + Polyfills ────────────────────────────────────────
// This module has ZERO imports so it evaluates immediately when imported.
// It must be the FIRST import in index.ts to catch errors during evaluation
// of other modules (e.g. react-native-libsodium JSI install crashing).
//
// ErrorUtils is a global provided by React Native before any JS runs.
// Using globalThis avoids any import that would be hoisted past this code.

// ─── Global polyfills for isomorphic-webcrypto / lib0 compatibility ─────────
// lib0/random → lib0/webcrypto → global crypto / isomorphic-webcrypto
//
// On Hermes (RN's JS engine), browser globals like `navigator` may not exist,
// and `window` may not be defined either. isomorphic-webcrypto (lib0's
// react-native webcrypto) reads `window.navigator` during module evaluation —
// a missing global throws a TypeError that crashes the app before React
// loads. Pre-populating fixes this. Also wires Hermes's native `crypto` to
// `window.crypto` so the correct implementation is used rather than a polyfill.
//
// There is deliberately no `document` stub: with `window` defined it makes
// lib0's `isBrowser` (and other libraries' DOM detection) true on a device,
// and nothing on the react-native resolution path reads it.

// 1. Provide `window` global
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {};
}

// 2. Provide `navigator` — needed by isomorphic-webcrypto/browser.js
if (typeof (globalThis as any).navigator === 'undefined') {
  (globalThis as any).navigator = { userAgent: 'ReactNative' };
}

// 3. Wire native Hermes crypto to window.crypto (if Hermes provides it)
//    Hermes on RN 0.85+ provides globalThis.crypto with getRandomValues.
//    Without it, leave window.crypto unset: isomorphic-webcrypto installs
//    its own implementation only `if (!window.crypto)`, so an empty
//    placeholder object would block it and leave getRandomValues undefined.
if ((globalThis as any).crypto) {
  (globalThis as any).window.crypto = (globalThis as any).crypto;
}

// 4. Ensure window.navigator is set (isomorphic-webcrypto/react-native.js checks it)
if (typeof (globalThis as any).window.navigator === 'undefined') {
  (globalThis as any).window.navigator = (globalThis as any).navigator;
}

// Log, then hand on to the handler React Native installed (red box in dev;
// on a fatal error, the native crash path). Replacing it outright would
// swallow fatal errors and leave the app running in a broken state.
const errorUtils = (globalThis as any).ErrorUtils;
const _previousHandler: ((error: any, isFatal?: boolean) => void) | undefined =
  errorUtils?.getGlobalHandler?.();

const _globalErrorHandler = (error: any, isFatal?: boolean) => {
  console.error(`[GlobalError] fatal=${isFatal}:`, error);
  _previousHandler?.(error, isFatal);
};

if (typeof errorUtils !== 'undefined') {
  errorUtils.setGlobalHandler(_globalErrorHandler);
}
