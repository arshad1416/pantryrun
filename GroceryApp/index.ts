// Entry point - bypasses Expo.fx that crashes on RN 0.85.3 + Hermes.
// Global error handler + webcrypto globals: must stay the first import (imports
// are hoisted, so it evaluates before every other module, including App).
import './src/error-handler';

if (typeof TextDecoder === 'undefined') {
  class TextDecoderPolyfill {
    decode(arr: Uint8Array): string {
      if (!arr) return '';
      let out = "";
      let i = 0;
      const len = arr.length;
      while (i < len) {
        const c = arr[i++];
        if (c < 128) {
          out += String.fromCharCode(c);
        } else if (c > 191 && c < 224) {
          out += String.fromCharCode(((c & 31) << 6) | (arr[i++] & 63));
        } else if (c > 223 && c < 240) {
          out += String.fromCharCode(((c & 15) << 12) | ((arr[i++] & 63) << 6) | (arr[i++] & 63));
        } else {
          const u = (((c & 7) << 18) | ((arr[i++] & 63) << 12) | ((arr[i++] & 63) << 6) | (arr[i++] & 63)) - 0x10000;
          out += String.fromCharCode(0xD800 + (u >> 10), 0xDC00 + (u & 0x3FF));
        }
      }
      return out;
    }
  }
  (globalThis as any).TextDecoder = TextDecoderPolyfill;
}

if (typeof TextEncoder === 'undefined') {
  class TextEncoderPolyfill {
    encode(str: string): Uint8Array {
      const arr = [];
      const len = str.length;
      for (let i = 0; i < len; i++) {
        let c = str.charCodeAt(i);
        if (c < 128) {
          arr.push(c);
        } else if (c < 2048) {
          arr.push((c >> 6) | 192);
          arr.push((c & 63) | 128);
        } else if (c < 55296 || c >= 57344) {
          arr.push((c >> 12) | 224);
          arr.push(((c >> 6) & 63) | 128);
          arr.push((c & 63) | 128);
        } else {
          i++;
          c = 0x10000 + (((c & 1023) << 10) | (str.charCodeAt(i) & 1023));
          arr.push((c >> 18) | 240);
          arr.push(((c >> 12) & 63) | 128);
          arr.push(((c >> 6) & 63) | 128);
          arr.push((c & 63) | 128);
        }
      }
      return new Uint8Array(arr);
    }
  }
  (globalThis as any).TextEncoder = TextEncoderPolyfill;
}

import { AppRegistry } from 'react-native';
import App from './App';

AppRegistry.registerComponent('main', () => App);

