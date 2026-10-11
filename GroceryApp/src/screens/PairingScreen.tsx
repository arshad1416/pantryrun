/**
 * Pairing Screen — QR code scanner for self-hosted relay setup.
 *
 * Provides:
 *  - QR scanner (expo-camera) for scanning pairing codes from a self-hosted server
 *  - Manual URL input fallback
 *  - "Test Connection" button that checks /health
 *  - Connection status display (connecting, connected, error)
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';

import { testRelayConnection, updateSettings } from '../config/settings';
import { parsePairingCode } from '../setup/self-host';
import type { ConnectionStatus, PairingCode, FamilyInviteToken } from '../types';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/deepLinks';

import CameraScanner from '../components/CameraScanner';

// ─── Props ──────────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<RootStackParamList, 'Pairing'>;

interface PairingScreenProps {
  onPairingComplete?: (pairingCode: PairingCode) => void;
}

// ─── Main Screen ─────────────────────────────────────────────────────────────

export default function PairingScreen({ navigation, route }: Props) {
  // Extract token from route params if navigated from Invite screen
  const inviteToken = (route.params as any)?.token;
  const [manualUrl, setManualUrl] = useState('');
  const [manualPort, setManualPort] = useState('8080');
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected');
  const [testingConnection, setTestingConnection] = useState(false);
  const [scannerActive, setScannerActive] = useState(false);
  const [parsedCode, setParsedCode] = useState<PairingCode | null>(null);
  const [statusMessage, setStatusMessage] = useState('');

  /**
   * Complete a scanned/linked invite end-to-end.
   *
   * Combined payloads ({ pairingCode, invite }) do the FULL family join:
   * verify pairing code → test relay connection → save settings → enroll
   * with the relay (obtains the relayToken that sync auth requires) → store
   * family membership → route to recovery-phrase entry for the shared key
   * (or start sync immediately if this device already has it).
   *
   * Legacy bare pairing codes just configure the relay connection.
   */
  const completeJoin = useCallback(
    async (tokenStr: string) => {
      try {
        setStatusMessage('Processing invite...');

        let payload: any;
        try {
          payload = JSON.parse(tokenStr);
        } catch {
          throw new Error("That invite link isn't valid. Ask for a new one.");
        }

        const isCombined = payload && typeof payload === 'object' && payload.pairingCode;
        const codeInput: PairingCode = isCombined ? payload.pairingCode : payload;
        const invite: FamilyInviteToken | null = isCombined ? payload.invite : null;

        const code = await parsePairingCode(codeInput);
        setParsedCode(code);
        setManualUrl(code.relayUrl);
        setStatusMessage('Invite looks good — connecting…');

        const portMatch = code.relayUrl.match(/:(\d+)$/);
        const port = portMatch ? parseInt(portMatch[1], 10) : 8080;

        setConnectionStatus('connecting');
        const ok = await testRelayConnection(code.relayUrl, port);
        if (!ok) {
          setConnectionStatus('error');
          setStatusMessage('Could not connect to the relay server');
          return;
        }

        await updateSettings({
          relayUrl: code.relayUrl,
          relayPort: port,
          pairingCode: tokenStr,
        });
        setConnectionStatus('connected');

        if (!invite) {
          // Legacy relay-only pairing (first device / self-host setup)
          setStatusMessage('Connected to relay server!');
          Alert.alert('Relay Paired', 'Connected to the relay server.', [
            { text: 'OK', onPress: () => navigation.navigate('Home') },
          ]);
          return;
        }

        // ── Family join: enroll with the relay, then store membership ──
        setStatusMessage('Setting up this device…');
        const { enrollWithRelay } = await import('../identity/enroll');
        const { acceptFamilyInvite } = await import('../identity/family');
        const { getDeviceId, getDeviceKeypair } = await import('../identity/device');

        const httpBase = code.relayUrl
          .replace(/^ws:/, 'http:')
          .replace(/^wss:/, 'https:');
        // Passing the keypair registers this device's signing key with the
        // relay, so it can invite the next family member itself.
        await enrollWithRelay(httpBase, getDeviceId(), JSON.stringify(invite), getDeviceKeypair());
        await acceptFamilyInvite(invite, getDeviceKeypair());

        const { getMasterKey, getMasterKeyType } = await import('../crypto');
        // A key this device minted for its own family-of-one on first launch
        // is not the key to the family it just joined, so an invitee holding
        // one still needs the family's phrase.
        const keyType = await getMasterKeyType();
        const hasKey = !!(await getMasterKey()) && keyType !== 'device';
        if (!hasKey) {
          setStatusMessage('Enrolled! One step left: family recovery phrase.');
          Alert.alert(
            'One More Step',
            "You've joined the family and this device is enrolled with the relay.\n\nTo unlock the shared lists, enter your family's 12-word recovery phrase (ask the person who invited you).\n\nNote: any lists you created on this device before joining are encrypted with its previous key and won't carry over.",
            [
              {
                text: 'Enter Recovery Phrase',
                onPress: () => navigation.navigate('Recovery', { mode: 'recover' }),
              },
            ],
          );
        } else {
          const { bootstrapSync } = await import('../sync/bootstrap');
          bootstrapSync().catch(() => {});
          setStatusMessage('Joined family — sync is starting.');
          Alert.alert(
            'Joined Family',
            "This device is enrolled and syncing using its existing key.\n\nIf shared lists don't appear, this device's key differs from the family's — open Settings → Security → Recover from Backup and enter the family's 12-word recovery phrase.",
            [{ text: 'OK', onPress: () => navigation.navigate('Home') }],
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid pairing code';
        setConnectionStatus('error');
        setStatusMessage(message);
        Alert.alert('Pairing Failed', message);
      }
    },
    [navigation],
  );

  // Process invite token if present (deep link / share sheet)
  useEffect(() => {
    if (inviteToken) {
      completeJoin(inviteToken);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteToken]);

  // Handle QR code scan result
  const handleScan = useCallback(
    async (data: string) => {
      await completeJoin(data);
    },
    [completeJoin],
  );

  // Handle manual test connection
  const handleManualTest = useCallback(async () => {
    if (!manualUrl) {
      Alert.alert('Missing URL', 'Please enter a WebSocket URL.');
      return;
    }

    setTestingConnection(true);
    setConnectionStatus('connecting');
    setStatusMessage('Testing connection...');

    const port = parseInt(manualPort, 10) || 8080;
    const ok = await testRelayConnection(manualUrl, port);

    if (ok) {
      setConnectionStatus('connected');
      setStatusMessage('Connected to relay server!');

      await updateSettings({
        relayUrl: manualUrl,
        relayPort: port,
      });
    } else {
      setConnectionStatus('error');
      setStatusMessage('Could not reach the relay server');
      Alert.alert(
        'Connection Failed',
        'Could not reach the relay server. Check the URL and port.',
      );
    }

    setTestingConnection(false);
  }, [manualUrl, manualPort]);

  // Connection status indicator
  const statusColor =
    connectionStatus === 'connected'
      ? '#4CAF50'
      : connectionStatus === 'error'
        ? '#f44336'
        : connectionStatus === 'connecting'
          ? '#FF9800'
          : '#999';

  const statusIcon =
    connectionStatus === 'connected'
      ? '✓'
      : connectionStatus === 'error'
        ? '✗'
        : connectionStatus === 'connecting'
          ? '⟳'
          : '•';

  return (
    <ScrollView style={styles.container}>
      <View style={styles.headerBar}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Pair with Relay</Text>
      </View>

      {/* ── QR Scanner Section ──────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Scan QR Code</Text>
        <Text style={styles.sectionDescription}>
          Point your camera at the QR code displayed on your self-hosted relay
          server's setup page.
        </Text>

        {scannerActive ? (
          <View style={styles.scannerContainer}>
            <CameraScanner
              onScan={(token) => {
                setScannerActive(false);
                handleScan(token);
              }}
              onCancel={() => setScannerActive(false)}
            />
          </View>
        ) : (
          <TouchableOpacity
            style={styles.scanButton}
            onPress={() => setScannerActive(true)}
          >
            <Text style={styles.scanButtonText}>Scan QR Code</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Manual URL Input ────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Manual Connection</Text>
        <Text style={styles.sectionDescription}>
          Enter the WebSocket URL and port of your relay server.
        </Text>

        <View style={styles.inputRow}>
          <Text style={styles.inputLabel}>WebSocket URL</Text>
          <TextInput
            style={styles.input}
            value={manualUrl}
            onChangeText={setManualUrl}
            placeholder="ws://192.168.1.100"
            placeholderTextColor="#999"
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={styles.inputRow}>
          <Text style={styles.inputLabel}>Port</Text>
          <TextInput
            style={[styles.input, styles.portInput]}
            value={manualPort}
            onChangeText={setManualPort}
            placeholder="8080"
            placeholderTextColor="#999"
            keyboardType="numeric"
          />
        </View>

        <TouchableOpacity
          style={[
            styles.testButton,
            testingConnection && styles.testButtonDisabled,
          ]}
          onPress={handleManualTest}
          disabled={testingConnection}
        >
          {testingConnection ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.testButtonText}>Test Connection</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* ── Recover from Backup ──────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Lost Your Device?</Text>
        <Text style={styles.sectionDescription}>
          If you've lost access to all your devices but have your recovery
          phrase, you can restore your family key here.
        </Text>
        <TouchableOpacity
          style={styles.recoverButton}
          onPress={() =>
            navigation.navigate('Recovery', { mode: 'recover' })
          }
        >
          <Text style={styles.recoverButtonText}>
            🔑 Recover from Backup
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Connection Status ───────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Status</Text>

        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]}>
            <Text style={styles.statusIcon}>{statusIcon}</Text>
          </View>
          <View style={styles.statusInfo}>
            <Text style={styles.statusLabel}>
              {connectionStatus === 'connected'
                ? 'Connected'
                : connectionStatus === 'error'
                  ? 'Error'
                  : connectionStatus === 'connecting'
                    ? 'Connecting...'
                    : 'Not connected'}
            </Text>
            {statusMessage ? (
              <Text style={styles.statusMessage}>{statusMessage}</Text>
            ) : null}
          </View>
        </View>

        {parsedCode && (
          <View style={styles.parsedCodeInfo}>
            <Text style={styles.parsedLabel}>Relay URL:</Text>
            <Text style={styles.parsedValue} selectable>
              {parsedCode.relayUrl}
            </Text>
            <Text style={styles.parsedLabel}>Family ID:</Text>
            <Text style={styles.parsedValue} selectable>
              {parsedCode.familyId}
            </Text>
            <Text style={styles.parsedLabel}>Device ID:</Text>
            <Text style={styles.parsedValue} selectable>
              {parsedCode.deviceId}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#333',
    padding: 20,
    paddingBottom: 8,
  },
  section: {
    margin: 12,
    marginTop: 4,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  sectionDescription: {
    fontSize: 13,
    color: '#666',
    marginBottom: 12,
    lineHeight: 18,
  },
  scannerPlaceholder: {
    height: 200,
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#ddd',
    borderStyle: 'dashed',
  },
  scannerContainer: {
    height: 300,
    borderRadius: 8,
    overflow: 'hidden',
  },
  scannerActive: {
    alignItems: 'center',
    gap: 12,
  },
  scannerText: {
    fontSize: 13,
    color: '#666',
    marginTop: 8,
  },
  scanButton: {
    backgroundColor: '#4CAF50',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  scanButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  cancelButton: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  cancelText: {
    color: '#f44336',
    fontSize: 14,
  },
  inputRow: {
    marginBottom: 12,
  },
  inputLabel: {
    fontSize: 13,
    color: '#666',
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    color: '#333',
    backgroundColor: '#fafafa',
  },
  portInput: {
    width: 120,
  },
  testButton: {
    backgroundColor: '#2196F3',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 4,
  },
  testButtonDisabled: {
    opacity: 0.6,
  },
  testButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusDot: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusIcon: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  statusInfo: {
    flex: 1,
  },
  statusLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  statusMessage: {
    fontSize: 13,
    color: '#666',
    marginTop: 2,
  },
  parsedCodeInfo: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#f8f8f8',
    borderRadius: 8,
  },
  parsedLabel: {
    fontSize: 11,
    color: '#999',
    marginTop: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  parsedValue: {
    fontSize: 13,
    color: '#333',
    fontFamily: 'monospace',
    marginTop: 1,
  },
  bottomSpacer: {
    height: 40,
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  backBtn: {
    paddingRight: 8,
    paddingVertical: 4,
  },
  backText: {
    fontSize: 16,
    color: '#4CAF50',
    fontWeight: '600',
  },
  recoverButton: {
    backgroundColor: '#FF9800',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  recoverButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});