/**
 * Hosted relay default — regression tests.
 *
 * New installs default to the free PantryRun relay (wss://relay.pantryrun.app,
 * port 443). Installs still carrying the pre-1.32 placeholder default
 * (ws://localhost, 8080, self-hosted) migrate to it exactly once; any URL or
 * port the user chose is left alone. Every call site that joins relayUrl and
 * relayPort must produce a valid URL for the hosted default AND keep working
 * for a self-hoster on ws://host:8080.
 *
 * Run: npx jest __tests__/hosted-relay-default.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import sodium from 'libsodium-wrappers';

const SETTINGS_KEY = 'groceryapp.settings.cache';
const DEVICE_KEY = 'groceryapp.device.settings_key';

type SettingsModule = typeof import('../src/config/settings');
type StoreModule = typeof import('../__mocks__/expo-secure-store');

/** Fresh copies of the settings module and the in-memory secure store. */
function freshModules(): { settings: SettingsModule; store: StoreModule } {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const store = require('expo-secure-store') as StoreModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const settings = require('../src/config/settings') as SettingsModule;
  return { settings, store };
}

/**
 * Persist `stored` as if an older build had written it, then "relaunch" (new
 * module instances fed the same secure-store bytes) and return what loads.
 */
async function relaunchWith(stored: Record<string, unknown>) {
  const first = freshModules();
  await first.settings.initSettings();
  // Overwrite the whole object: updateSettings merges, so build it explicitly
  // and drop any key set to undefined (JSON.stringify omits them).
  await first.settings.updateSettings(stored as any);
  const blob = await first.store.getItemAsync(SETTINGS_KEY);
  const key = await first.store.getItemAsync(DEVICE_KEY);

  const second = freshModules();
  second.store._clearStore();
  await second.store.setItemAsync(SETTINGS_KEY, blob!);
  await second.store.setItemAsync(DEVICE_KEY, key!);
  const loaded = await second.settings.initSettings();
  return { loaded, settings: second.settings };
}

beforeAll(async () => {
  await sodium.ready;
});

beforeEach(() => {
  const { store } = freshModules();
  store._clearStore();
});

describe('new installs', () => {
  it('default to the hosted relay on wss + 443', async () => {
    const { settings } = freshModules();
    const s = await settings.initSettings();
    expect(s.hostingTier).toBe('managed');
    expect(s.relayUrl).toBe('wss://relay.pantryrun.app');
    expect(s.relayPort).toBe(443);
    expect(settings.HOSTED_RELAY_URL).toBe('wss://relay.pantryrun.app');
  });
});

describe('legacy default migration', () => {
  it('moves the untouched ws://localhost:8080 default to the hosted relay', async () => {
    const { loaded } = await relaunchWith({
      hostingTier: 'self_hosted',
      relayUrl: 'ws://localhost',
      relayPort: 8080,
      hostedRelayDefaultMigrated: undefined,
    });
    expect(loaded.hostingTier).toBe('managed');
    expect(loaded.relayUrl).toBe('wss://relay.pantryrun.app');
    expect(loaded.relayPort).toBe(443);
  });

  it('never overrides a custom self-hosted URL', async () => {
    const { loaded } = await relaunchWith({
      hostingTier: 'self_hosted',
      relayUrl: 'ws://relay.home.arpa',
      relayPort: 8080,
      hostedRelayDefaultMigrated: undefined,
    });
    expect(loaded.hostingTier).toBe('self_hosted');
    expect(loaded.relayUrl).toBe('ws://relay.home.arpa');
    expect(loaded.relayPort).toBe(8080);
  });

  it('never overrides localhost with a custom port', async () => {
    const { loaded } = await relaunchWith({
      hostingTier: 'self_hosted',
      relayUrl: 'ws://localhost',
      relayPort: 9090,
      hostedRelayDefaultMigrated: undefined,
    });
    expect(loaded.relayUrl).toBe('ws://localhost');
    expect(loaded.relayPort).toBe(9090);
  });

  it('relabels a stale managed tier that points at a custom URL as self-hosted', async () => {
    const { loaded } = await relaunchWith({
      hostingTier: 'managed',
      relayUrl: 'wss://my.example.com',
      relayPort: 443,
      hostedRelayDefaultMigrated: undefined,
    });
    expect(loaded.hostingTier).toBe('self_hosted');
    expect(loaded.relayUrl).toBe('wss://my.example.com');
  });

  it('runs once: a later deliberate ws://localhost is kept', async () => {
    const { loaded } = await relaunchWith({
      hostingTier: 'self_hosted',
      relayUrl: 'ws://localhost',
      relayPort: 8080,
      hostedRelayDefaultMigrated: true,
    });
    expect(loaded.hostingTier).toBe('self_hosted');
    expect(loaded.relayUrl).toBe('ws://localhost');
  });
});

describe('tier switching moves the relay URL', () => {
  it('self-hosted clears the hosted URL and restores port 8080; hosted pins ours', async () => {
    const { settings } = freshModules();
    await settings.initSettings();

    const self = await settings.selectSelfHostedRelay();
    expect(self.hostingTier).toBe('self_hosted');
    expect(self.relayUrl).toBe('');
    expect(self.relayPort).toBe(8080);

    await settings.updateSettings({ relayUrl: 'ws://relay.home.arpa' });
    const hosted = await settings.selectHostedRelay();
    expect(hosted.hostingTier).toBe('managed');
    expect(hosted.relayUrl).toBe('wss://relay.pantryrun.app');
    expect(hosted.relayPort).toBe(443);
  });

  it('switching to self-hosted keeps a custom URL the user already entered', async () => {
    const { settings } = freshModules();
    await settings.initSettings();
    await settings.updateSettings({ relayUrl: 'wss://my.example.com', relayPort: 443 });
    const self = await settings.selectSelfHostedRelay();
    expect(self.relayUrl).toBe('wss://my.example.com');
    expect(self.relayPort).toBe(443);
  });
});

describe('relayUrl + relayPort joining', () => {
  it('the hosted default yields a valid https base for REST calls', async () => {
    const { settings } = freshModules();
    await settings.initSettings();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRelayHttpBaseUrl } = require('../src/pricing/relay-client');
    const base = getRelayHttpBaseUrl();
    expect(base).toBe('https://relay.pantryrun.app:443');
    expect(new URL(`${base}/health`).host).toBe('relay.pantryrun.app');
  });

  it('a self-hoster on ws://host + 8080 still gets http://host:8080', async () => {
    const { settings } = freshModules();
    await settings.initSettings();
    await settings.updateSettings({
      hostingTier: 'self_hosted',
      relayUrl: 'ws://relay.home.arpa',
      relayPort: 8080,
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRelayHttpBaseUrl } = require('../src/pricing/relay-client');
    expect(getRelayHttpBaseUrl()).toBe('http://relay.home.arpa:8080');
  });
});
