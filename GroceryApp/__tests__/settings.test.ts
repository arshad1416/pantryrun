/**
 * Settings Store Tests
 *
 * Tests for:
 *  - Settings store round-trip encrypt/decrypt
 *  - Tier switching persists correctly
 *  - Test connection to relay /health endpoint
 *  - Pairing code generation and parsing
 *  - Invalid pairing code rejected
 */

import sodium from 'libsodium-wrappers';
import {
  initSettings,
  getSettings,
  updateSettings,
  setHostingTier,
  getHostingTier,
  testRelayConnection,
  setRelayUrl,
  setRelayPort,
  clearSettings,
} from '../src/config/settings';
import {
  generatePairingCode,
  parsePairingCodeString,
} from '../src/setup/self-host';
import { initDeviceIdentity, getDeviceId, clearDeviceIdentity } from '../src/identity/device';
import * as SecureStore from 'expo-secure-store';

// Mock expo-secure-store
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  getItemAsync: jest.fn().mockResolvedValue(null),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));



// Mock fetch for testRelayConnection
global.fetch = jest.fn();

beforeAll(async () => {
  await sodium.ready;
});

beforeEach(async () => {
  jest.clearAllMocks();
  // Reset SecureStore mock to return null by default
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(null);
  (SecureStore.setItemAsync as jest.Mock).mockResolvedValue(undefined);
  (SecureStore.deleteItemAsync as jest.Mock).mockResolvedValue(undefined);

  // Re-init each time
  try {
    await initDeviceIdentity();
  } catch {
    // May already be initialized
  }
});

afterEach(async () => {
  await clearSettings().catch(() => {});
  await clearDeviceIdentity().catch(() => {});
});

describe('Settings Store Round-Trip', () => {
  test('initSettings returns defaults on first launch', async () => {
    // Mock SecureStore to have no stored settings
    (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'groceryapp.device.settings_key') {
        // Return a pre-generated key so encryption works
        return Promise.resolve('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32');
      }
      return Promise.resolve(null);
    });

    const settings = await initSettings();

    expect(settings).toBeDefined();
    // New installs default to the free PantryRun-hosted relay.
    expect(settings.hostingTier).toBe('managed');
    expect(settings.relayUrl).toBe('wss://relay.pantryrun.app');
    expect(settings.relayPort).toBe(443);
    expect(settings.localAiEndpoint).toBe('http://localhost:1234');
    expect(settings.priceServiceEnabled).toBe(false);
    expect(settings.voiceInputEnabled).toBe(false);
    expect(settings.barcodeScanningEnabled).toBe(false);
  });

  test('updateSettings persists and returns updated values', async () => {
    // Mock a valid device settings key
    (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'groceryapp.device.settings_key') {
        return Promise.resolve('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32');
      }
      return Promise.resolve(null);
    });

    await initSettings();

    const updated = await updateSettings({
      relayUrl: 'ws://my-relay.example.com',
      relayPort: 9090,
      priceServiceEnabled: true,
    });

    expect(updated.relayUrl).toBe('ws://my-relay.example.com');
    expect(updated.relayPort).toBe(9090);
    expect(updated.priceServiceEnabled).toBe(true);

    // Verify it was persisted (setItemAsync called with encrypted data)
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'groceryapp.settings.cache',
      expect.any(String),
    );
  });

  test('getSettings returns cached values after init', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'groceryapp.device.settings_key') {
        return Promise.resolve('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32');
      }
      return Promise.resolve(null);
    });

    await initSettings();
    await updateSettings({ relayUrl: 'ws://test:1234' });

    const cached = getSettings();
    expect(cached.relayUrl).toBe('ws://test:1234');
  });
});

describe('Tier Switching', () => {
  test('setHostingTier persists tier selection', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'groceryapp.device.settings_key') {
        return Promise.resolve('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32');
      }
      return Promise.resolve(null);
    });

    await initSettings();
    expect(getHostingTier()).toBe('managed');

    await setHostingTier('self_hosted');
    expect(getHostingTier()).toBe('self_hosted');

    await setHostingTier('managed');
    expect(getHostingTier()).toBe('managed');

    await setHostingTier('self_hosted');
    expect(getHostingTier()).toBe('self_hosted');
  });

  test('getSettings reflects tier after updateSettings', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'groceryapp.device.settings_key') {
        return Promise.resolve('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32');
      }
      return Promise.resolve(null);
    });

    await initSettings();
    const managed = await updateSettings({ hostingTier: 'managed' });
    expect(managed.hostingTier).toBe('managed');
  });
});

describe('Test Relay Connection', () => {
  beforeEach(() => {
    (global.fetch as jest.Mock).mockReset();
  });

  test('testRelayConnection returns true on 200', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
    });

    const result = await testRelayConnection('ws://localhost', 8080);
    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('testRelayConnection returns false on non-200', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
    });

    const result = await testRelayConnection('ws://localhost', 8080);
    expect(result).toBe(false);
  });

  test('testRelayConnection returns false on network error', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

    const result = await testRelayConnection('ws://localhost', 8080);
    expect(result).toBe(false);
  });

  test('testRelayConnection uses correct URL with wss://', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

    await testRelayConnection('wss://relay.example.com', 443);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://relay.example.com:443/health',
      expect.anything(),
    );
  });
});

describe('Settings CRUD', () => {
  test('setRelayUrl updates correctly', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'groceryapp.device.settings_key') {
        return Promise.resolve('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32');
      }
      return Promise.resolve(null);
    });

    await initSettings();
    const r = await setRelayUrl('ws://new-relay:9999');
    expect(r.relayUrl).toBe('ws://new-relay:9999');
  });

  test('setRelayPort updates correctly', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'groceryapp.device.settings_key') {
        return Promise.resolve('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32');
      }
      return Promise.resolve(null);
    });

    await initSettings();
    const r = await setRelayPort(9090);
    expect(r.relayPort).toBe(9090);
  });
});

describe('Pairing Code Generation and Parsing', () => {
  test('generatePairingCode creates valid code', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'groceryapp.device.settings_key') {
        return Promise.resolve('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32');
      }
      return Promise.resolve(null);
    });

    await initDeviceIdentity();
    const deviceId = getDeviceId();

    const code = await generatePairingCode(
      deviceId,
      'test-family-id',
      'ws://localhost:8080',
    );

    expect(code).toBeDefined();
    expect(code.version).toBe(1);
    expect(code.deviceId).toBe(deviceId);
    expect(code.familyId).toBe('test-family-id');
    expect(code.relayUrl).toBe('ws://localhost:8080');
    expect(code.signature).toBeDefined();
    expect(typeof code.signature).toBe('string');
    expect(code.signature.length).toBeGreaterThan(0);
    expect(code.createdAt).toBeGreaterThan(0);
  });

  test('parsePairingCodeString verifies valid code', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'groceryapp.device.settings_key') {
        return Promise.resolve('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32');
      }
      // Mock device identity storage to return consistent keys
      if (key === 'groceryapp.device.secret_key') {
        return Promise.resolve(
          'R6VdgKrnqkhylPLNJKKXY6fEpgWK7bbRFRHy8enKZG90TGVDISA12ovJLfHV/tx5ZNj8gTGK2LhLRZ5tN5buCA=='
        );
      }
      if (key === 'groceryapp.device.public_key') {
        return Promise.resolve('dExlQyEgNdqLyS3x0/bceWTY/IExiti4S0WebTeW7gg=');
      }
      if (key === 'groceryapp.device.id') {
        return Promise.resolve('dExlQyEgNdqLyS3x0/bceWTY/IExiti4S0WebTeW7gg=');
      }
      return Promise.resolve(null);
    });

    await initDeviceIdentity();
    const deviceId = getDeviceId();

    const code = await generatePairingCode(
      deviceId,
      'test-family',
      'ws://localhost:8080',
    );

    const json = JSON.stringify(code);
    const parsed = await parsePairingCodeString(json);

    expect(parsed.familyId).toBe('test-family');
    expect(parsed.deviceId).toBe(deviceId);
    expect(parsed.relayUrl).toBe('ws://localhost:8080');
  });

  test('parsePairingCodeString rejects invalid code', async () => {
    await expect(
      parsePairingCodeString('{"version":1,"deviceId":"bad","familyId":"test","relayUrl":"ws://x","signature":"bad","createdAt":1}'),
    ).rejects.toThrow();
  });

  test('parsePairingCodeString rejects non-JSON', async () => {
    await expect(
      parsePairingCodeString('not-json'),
    ).rejects.toThrow();
  });
});