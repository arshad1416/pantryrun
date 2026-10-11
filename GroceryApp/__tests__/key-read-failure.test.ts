/**
 * A stored key that cannot be read must never be treated as "no key".
 *
 * getMasterKey swallowed every SecureStore error and JSON parse failure into
 * null, and bootstrapSync treats null as a first launch. So a transient
 * Keychain failure (device still locked after a reboot, a keystore hiccup)
 * minted a new master key and recovery phrase over the real one, orphaning
 * every list encrypted under it. The device keypair had the same shape:
 * a throwing read generated a new identity.
 *
 * Now the read failure is a KeyReadError: bootstrap stops (App.tsx shows its
 * error screen with Retry and "Restore with recovery phrase"), nothing is
 * written, and restoring over an unreadable key needs the same explicit
 * confirmation as replacing a different key.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as SecureStore from 'expo-secure-store';
import { initCrypto, getMasterKey, KeyReadError } from '../src/crypto';
import { initDeviceIdentity, getDeviceKeypair } from '../src/identity/device';
import { ensureFamilyMembership, clearFamilyMembership } from '../src/identity/family';
import { generateRecoveryPhrase, recoverFromPhrase, RecoveryOverwriteError } from '../src/identity/recovery';
import { bootstrapSync } from '../src/sync/bootstrap';

const MASTER_KEY_ALIAS = 'groceryapp.master_key';
const store = SecureStore as any;

function failReadsOf(alias: string) {
  const real = store.getItemAsync;
  return jest.spyOn(store, 'getItemAsync').mockImplementation(((key: string) =>
    key === alias ? Promise.reject(new Error('User interaction is not allowed.')) : real(key)) as any);
}

beforeEach(async () => {
  store._clearStore();
  await initCrypto();
  await clearFamilyMembership();
  await initDeviceIdentity();
  await ensureFamilyMembership(getDeviceKeypair());
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('master key read failures', () => {
  it('bootstrapSync stops instead of provisioning over an unreadable key', async () => {
    await generateRecoveryPhrase();
    const original = await store.getItemAsync(MASTER_KEY_ALIAS);
    expect(original).toBeTruthy();

    failReadsOf(MASTER_KEY_ALIAS);
    const writes = jest.spyOn(store, 'setItemAsync');

    await expect(bootstrapSync()).rejects.toBeInstanceOf(KeyReadError);
    expect(writes).not.toHaveBeenCalled();

    jest.restoreAllMocks();
    expect(await store.getItemAsync(MASTER_KEY_ALIAS)).toBe(original);
  });

  it('a malformed stored value is a read error; an absent one is still null', async () => {
    expect(await getMasterKey()).toBeNull();

    await store.setItemAsync(MASTER_KEY_ALIAS, '{not json');
    await expect(getMasterKey()).rejects.toBeInstanceOf(KeyReadError);
    await expect(bootstrapSync()).rejects.toBeInstanceOf(KeyReadError);
    expect(await store.getItemAsync(MASTER_KEY_ALIAS)).toBe('{not json');
  });

  it('restoring over an unreadable key needs the explicit overwrite confirmation', async () => {
    const phrase = await generateRecoveryPhrase();
    const real = await getMasterKey();
    await store.setItemAsync(MASTER_KEY_ALIAS, '{not json');

    await expect(recoverFromPhrase(phrase)).rejects.toBeInstanceOf(RecoveryOverwriteError);
    expect(await store.getItemAsync(MASTER_KEY_ALIAS)).toBe('{not json');

    const restored = await recoverFromPhrase(phrase, { allowOverwrite: true });
    expect(Array.from(restored)).toEqual(Array.from(real!));
    expect(Array.from((await getMasterKey())!)).toEqual(Array.from(real!));
  });
});

describe('device identity read failures', () => {
  it('initDeviceIdentity throws rather than generating a replacement keypair', async () => {
    const before = await store.getItemAsync('groceryapp.device.public_key');
    failReadsOf('groceryapp.device.secret_key');
    const writes = jest.spyOn(store, 'setItemAsync');

    const err = await initDeviceIdentity().catch((e) => e);
    expect(err).toBeInstanceOf(KeyReadError);
    expect((err as KeyReadError).subject).toBe('device-identity');
    expect(writes).not.toHaveBeenCalled();

    jest.restoreAllMocks();
    expect(await store.getItemAsync('groceryapp.device.public_key')).toBe(before);
  });
});

describe('startup error screen (App.tsx)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8');

  it('does not swallow a KeyReadError from bootstrap', () => {
    expect(app).toMatch(/e\.name === 'KeyReadError'\) throw e/);
  });

  it('offers recovery from the phrase, opening Recovery in recover mode', () => {
    expect(app).toMatch(/Restore with recovery phrase/);
    expect(app).toMatch(/navigate\('Recovery', \{ mode: 'recover' \}\)/);
  });
});
