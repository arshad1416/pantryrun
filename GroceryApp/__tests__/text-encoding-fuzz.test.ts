import { TextEncoder as NativeEncoder, TextDecoder as NativeDecoder } from 'util';
import { Utf8TextEncoder, Utf8TextDecoder } from '../src/polyfills/textEncoding';

// Node's independent WHATWG implementation is the oracle, not a round-trip
// through our own encoder. A fixed seed makes every failure reproducible.
function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
}

describe('Hermes UTF-8 fallback differential fuzz', () => {
  const encoder = new Utf8TextEncoder();
  const nativeEncoder = new NativeEncoder();
  it.each(['\ud800A', '\udc00B', '\ud800', '\udfff', '🍎牛奶 café', '\ufeffmilk', ''])('encodes %p without losing adjacent text', (text) => {
    expect(encoder.encode(text)).toEqual(nativeEncoder.encode(text));
  });

  it('matches native encoding for 3000 seeded arbitrary UTF-16 strings', () => {
    const next = random(0x12345678);
    for (let n = 0; n < 3000; n++) {
      let text = '';
      for (let i = next() % 60; i > 0; i--) text += String.fromCharCode(next() & 0xffff);
      expect(encoder.encode(text)).toEqual(nativeEncoder.encode(text));
    }
  });

  it('matches native decode for all one- and two-byte inputs', () => {
    const decoder = new Utf8TextDecoder();
    const native = new NativeDecoder();
    for (let a = 0; a < 256; a++) {
      expect(decoder.decode(new Uint8Array([a]))).toBe(native.decode(new Uint8Array([a])));
      for (let b = 0; b < 256; b++) {
        const bytes = new Uint8Array([a, b]);
        expect(decoder.decode(bytes)).toBe(native.decode(bytes));
      }
    }
  });

  it('matches native decode and streaming for 3000 seeded byte sequences', () => {
    const next = random(0x87654321);
    for (let n = 0; n < 3000; n++) {
      const bytes = Uint8Array.from({ length: next() % 60 }, () => next() >>> 24);
      for (const ignoreBOM of [false, true]) {
        const decoder = new Utf8TextDecoder('utf-8', { ignoreBOM });
        const native = new NativeDecoder('utf-8', { ignoreBOM });
        expect(decoder.decode(bytes)).toBe(native.decode(bytes));
        const cut = next() % (bytes.length + 1);
        expect(decoder.decode(bytes.slice(0, cut), { stream: true }) + decoder.decode(bytes.slice(cut)))
          .toBe(native.decode(bytes.slice(0, cut), { stream: true }) + native.decode(bytes.slice(cut)));
      }
    }
  });

  it('decodes offsets, split BOM/astral characters, fatal errors and reuses decoder', () => {
    const bytes = nativeEncoder.encode('\ufeff🍎milk');
    for (let cut = 0; cut <= bytes.length; cut++) {
      const decoder = new Utf8TextDecoder();
      expect(decoder.decode(bytes.subarray(0, cut), { stream: true }) + decoder.decode(bytes.subarray(cut))).toBe('🍎milk');
      expect(decoder.decode(bytes.buffer)).toBe('🍎milk');
    }
    expect(new Utf8TextDecoder().decode(new DataView(new Uint8Array([0, 65, 0]).buffer, 1, 1))).toBe('A');
    expect(() => new Utf8TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xe0, 0x80]))).toThrow(TypeError);
    expect(new Utf8TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toBe('\ufeff🍎milk');
  });

  it('encodeInto never emits partial characters and reports UTF-16 read count', () => {
    for (const text of ['A🍎B', '\ud800A', '\udc00B', '牛奶', '']) {
      for (let size = 0; size < 16; size++) {
        const actual = new Uint8Array(size);
        const expected = new Uint8Array(size);
        expect(encoder.encodeInto(text, actual)).toEqual(nativeEncoder.encodeInto(text, expected));
        expect(actual).toEqual(expected);
      }
    }
  });
});

describe('fallback bootstrap', () => {
  it('preserves native implementations', () => {
    const encoder = globalThis.TextEncoder;
    const decoder = globalThis.TextDecoder;
    jest.isolateModules(() => require('../src/polyfills/textEncoding'));
    expect(globalThis.TextEncoder).toBe(encoder);
    expect(globalThis.TextDecoder).toBe(decoder);
  });

  it('installs before dependent module evaluation when native globals are absent', () => {
    const encoder = globalThis.TextEncoder;
    const decoder = globalThis.TextDecoder;
    try {
      (globalThis as any).TextEncoder = undefined;
      (globalThis as any).TextDecoder = undefined;
      jest.isolateModules(() => {
        const fallback = require('../src/polyfills/textEncoding');
        expect(globalThis.TextEncoder).toBe(fallback.Utf8TextEncoder);
        expect(globalThis.TextDecoder).toBe(fallback.Utf8TextDecoder);
        expect(new TextDecoder().decode(new TextEncoder().encode('🍎milk'))).toBe('🍎milk');
      });
    } finally {
      globalThis.TextEncoder = encoder;
      globalThis.TextDecoder = decoder;
    }
  });
});
