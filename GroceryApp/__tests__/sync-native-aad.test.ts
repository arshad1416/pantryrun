import sodium from 'libsodium-wrappers';
import { YjsWebSocketClient } from '../src/sync/y-websocket';
import { loadQueueEntries } from '../src/sync/offline-queue-store';

// Unlike the WASM test double, the installed native binding accepts string
// AAD only. Preserve real authenticated encryption while enforcing that API.
jest.mock('react-native-libsodium', () => {
  const actual = require('libsodium-wrappers');
  const native = Object.create(actual);
  native.crypto_aead_xchacha20poly1305_ietf_encrypt = (...args: any[]) => {
    if (typeof args[1] !== 'string') throw new Error('native encryption requires string AAD');
    return actual.crypto_aead_xchacha20poly1305_ietf_encrypt(...args);
  };
  native.crypto_aead_xchacha20poly1305_ietf_decrypt = (...args: any[]) => {
    if (typeof args[2] !== 'string') throw new Error('native decryption requires string AAD');
    return actual.crypto_aead_xchacha20poly1305_ietf_decrypt(...args);
  };
  return native;
});

const { _resetDB } = require('@nozbe/watermelondb');
const key = new Uint8Array(32).fill(19);
const listId = 'native-aad-é-🛒';
const update = new Uint8Array([0, 255, 1, 2, 128, 13]);

async function client() {
  const value = new YjsWebSocketClient({
    url: 'ws://127.0.0.1:19998', familyId: 'synthetic-family',
    deviceId: 'synthetic-device', encryptionKey: key,
  });
  jest.spyOn(value, 'connect').mockImplementation(() => {});
  await value.init();
  return value;
}

beforeAll(async () => { await sodium.ready; });
afterEach(() => { _resetDB(); });

it('persists offline updates with native string AAD and a wire-compatible envelope', async () => {
  const sender = await client();
  const errors: Error[] = [];
  sender.onError = (error) => errors.push(error);
  sender.sendUpdate(listId, update);
  // Allow the async queue-store import and writer to complete.
  for (let tick = 0; tick < 5; tick++) await new Promise<void>((resolve) => setImmediate(resolve));
  const entries = await loadQueueEntries();
  expect(errors).toEqual([]);
  expect(entries).toHaveLength(1);
  const payload = entries[0].payload;
  const ciphertext = sodium.from_base64(payload.ciphertext, sodium.base64_variants.ORIGINAL);
  const tag = sodium.from_base64(payload.tag, sodium.base64_variants.ORIGINAL);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext); combined.set(tag, ciphertext.length);
  // A peer using the original UTF-8 byte AAD can decrypt the native sender.
  expect(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, combined, new TextEncoder().encode(listId),
    sodium.from_base64(payload.iv, sodium.base64_variants.ORIGINAL), key,
  )).toEqual(update);
  sender.disconnect();
});

it('decrypts existing byte-AAD envelopes through the native string-AAD API', async () => {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const combined = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    update, new TextEncoder().encode(listId), null, nonce, key,
  );
  const receiver = await client();
  const applied = jest.fn();
  const errors: Error[] = [];
  receiver.onRemoteUpdate = applied;
  receiver.onError = (error) => errors.push(error);
  await (receiver as any).handleMessage({ type: 'update', listId, payload: {
    ciphertext: sodium.to_base64(combined.slice(0, -16), sodium.base64_variants.ORIGINAL),
    tag: sodium.to_base64(combined.slice(-16), sodium.base64_variants.ORIGINAL),
    iv: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  } });
  expect(errors).toEqual([]);
  expect(applied).toHaveBeenCalledWith(listId, update);
  receiver.disconnect();
});
