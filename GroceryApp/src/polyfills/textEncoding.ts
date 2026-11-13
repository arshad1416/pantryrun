/** UTF-8 fallbacks for Hermes. Native implementations, when present, win.
 * Invalid UTF-16/UTF-8 uses U+FFFD rather than silently eating adjacent text.
 * Import before modules which capture TextEncoder/TextDecoder at evaluation.
 */
export class Utf8TextEncoder {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    const bytes: number[] = [];
    for (const char of String(input)) {
      let c = char.codePointAt(0)!;
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(bytes);
  }

  encodeInto(input: string, destination: Uint8Array): { read: number; written: number } {
    let read = 0;
    let written = 0;
    for (const char of String(input)) {
      const bytes = this.encode(char);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += char.length;
    }
    return { read, written };
  }
}

export class Utf8TextDecoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  private pending: number[] = [];
  private bomSeen = false;

  constructor(label = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(label.trim().toLowerCase())) {
      throw new RangeError('Only UTF-8 is supported');
    }
    this.fatal = !!options.fatal;
    this.ignoreBOM = !!options.ignoreBOM;
  }

  decode(input?: ArrayBuffer | ArrayBufferView, options: { stream?: boolean } = {}): string {
    const view = input === undefined ? new Uint8Array(0) : ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    const bytes = this.pending.concat(Array.from(view));
    this.pending = [];
    let output = '';
    const emit = (point: number) => {
      if (!this.bomSeen) {
        this.bomSeen = true;
        if (point === 0xfeff && !this.ignoreBOM) return;
      }
      output += String.fromCodePoint(point);
    };
    const invalid = () => {
      if (this.fatal) throw new TypeError('The encoded data was not valid UTF-8');
      emit(0xfffd);
    };
    try {
      let i = 0;
      while (i < bytes.length) {
        const start = i;
        const lead = bytes[i++];
        if (lead < 0x80) { emit(lead); continue; }
        let needed: number;
        let point: number;
        let lower = 0x80;
        let upper = 0xbf;
        if (lead >= 0xc2 && lead <= 0xdf) { needed = 1; point = lead & 31; }
        else if (lead >= 0xe0 && lead <= 0xef) {
          needed = 2; point = lead & 15;
          if (lead === 0xe0) lower = 0xa0;
          if (lead === 0xed) upper = 0x9f;
        } else if (lead >= 0xf0 && lead <= 0xf4) {
          needed = 3; point = lead & 7;
          if (lead === 0xf0) lower = 0x90;
          if (lead === 0xf4) upper = 0x8f;
        } else { invalid(); continue; }
        let complete = true;
        for (let n = 0; n < needed; n++) {
          if (i === bytes.length) {
            if (options.stream) this.pending = bytes.slice(start);
            else invalid();
            complete = false;
            break;
          }
          const b = bytes[i];
          if (b < lower || b > upper) { invalid(); complete = false; break; }
          i++;
          point = (point << 6) | (b & 63);
          lower = 0x80; upper = 0xbf;
        }
        if (complete) emit(point);
      }
      return output;
    } finally {
      if (!options.stream) { this.pending = []; this.bomSeen = false; }
    }
  }
}

if (typeof globalThis.TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = Utf8TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  (globalThis as any).TextDecoder = Utf8TextDecoder;
}
