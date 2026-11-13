/**
 * Family-notification AAD must be a string on device.
 *
 * The native react-native-libsodium bridge only accepts a STRING for the AEAD
 * additional_data argument (lib.native.ts:789/833 throw
 * "input type not yet implemented" otherwise). NotificationManager used to
 * pass `new TextEncoder().encode(listId)` there, so every family notification
 * failed to encrypt/decrypt on a release build. Jest never saw it because the
 * mock re-exports libsodium-wrappers, which accepts a Uint8Array.
 *
 * This test runs the real send → receive path against a shim that reproduces
 * the native string-only constraint. libsodium UTF-8 encodes string AAD, so
 * the wire format is unchanged: a peer using byte AAD can still decrypt.
 *
 * Run: npx jest __tests__/notification-native-aad.test.ts
 */

import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import realSodium from 'libsodium-wrappers';

jest.mock('react-native-libsodium', () => {
  const actual = require('libsodium-wrappers');
  const rejectNonString = (name: string) => {
    throw new Error(`${name}: input type not yet implemented`);
  };
  return new Proxy(actual, {
    get(target: any, prop: string | symbol) {
      if (prop === 'crypto_aead_xchacha20poly1305_ietf_encrypt') {
        return (message: any, additionalData: any, ...rest: any[]) => {
          if (typeof additionalData !== 'string') rejectNonString(prop);
          return target.crypto_aead_xchacha20poly1305_ietf_encrypt(
            message, additionalData, ...rest,
          );
        };
      }
      if (prop === 'crypto_aead_xchacha20poly1305_ietf_decrypt') {
        return (secretNonce: any, ciphertext: any, additionalData: any, ...rest: any[]) => {
          if (typeof additionalData !== 'string') rejectNonString(prop);
          return target.crypto_aead_xchacha20poly1305_ietf_decrypt(
            secretNonce, ciphertext, additionalData, ...rest,
          );
        };
      }
      return target[prop];
    },
  });
});

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true });
jest.mock('expo-notifications', () => ({
  setNotificationChannelAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  setBadgeCountAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  AndroidImportance: { HIGH: 4 },
}), { virtual: true });

let mockDeviceId = 'device-sender';
jest.mock('../src/identity/device', () => ({ getDeviceId: () => mockDeviceId }));

const mockSent: any[] = [];
jest.mock('../src/sync/sync-manager', () => ({
  syncManager: {
    sendNotification: (listId: string, payload: any) => {
      mockSent.push({ listId, payload });
    },
  },
}));

jest.mock('../src/notifications/NotificationRepository', () => ({
  saveNotification: jest.fn(),
}));
jest.mock('../src/state/useNotificationStore', () => ({
  useNotificationStore: { getState: () => ({ onNotificationReceived: jest.fn() }) },
}));

import { sendFamilyNotification, handleIncomingNotification } from '../src/notifications/NotificationManager';

const encryptionKey = new Uint8Array(32).fill(23);
const listId = 'family-list-é-🛒';

beforeAll(async () => {
  await realSodium.ready;
});

it('round-trips a family notification through the native string-only AAD path', async () => {
  mockDeviceId = 'device-sender';
  await sendFamilyNotification(
    'item_added', listId, 'Weekly Shop', 'item-1', 'Oat Milk', 'dairy', encryptionKey,
  );

  expect(mockSent).toHaveLength(1);
  const { listId: sentListId, payload } = mockSent[0];
  expect(sentListId).toBe(listId);

  // A peer that still uses UTF-8 bytes as AAD gets the same authenticated
  // bytes, so the fix does not change the wire format.
  const ciphertext = realSodium.from_base64(payload.ciphertext, realSodium.base64_variants.ORIGINAL);
  const tag = realSodium.from_base64(payload.tag, realSodium.base64_variants.ORIGINAL);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const plaintext = realSodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    combined,
    new TextEncoder().encode(listId),
    realSodium.from_base64(payload.iv, realSodium.base64_variants.ORIGINAL),
    encryptionKey,
  );
  expect(JSON.parse(new TextDecoder().decode(plaintext)).itemName).toBe('Oat Milk');

  mockDeviceId = 'device-receiver';
  const received = await handleIncomingNotification(listId, payload, encryptionKey);
  expect(received).toMatchObject({
    itemName: 'Oat Milk',
    listId,
    eventType: 'item_added',
  });
});
