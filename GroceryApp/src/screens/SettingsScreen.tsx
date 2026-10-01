/**
 * Settings Screen — two-tier hosting configuration.
 *
 * Provides:
 *  - Tier selector (self-hosted / managed) as a segmented control
 *  - Relay URL input with "Test Connection" button
 *  - Pairing code display (QR code) for self-hosted
 *  - Managed tier: subscription key input + plan info
 *  - Toggle switches for opt-in features
 *  - Local AI endpoint input (self-hosted only)
 *
 * Uses expo-secure-store via the settings module for persistence.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Switch,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';

import {
  initSettings,
  getSettings,
  updateSettings,
  testRelayConnection,
  setHostingTier,
} from '../config/settings';
import { getDeviceId } from '../identity/device';
import type { AppSettings, HostingTier, ConnectionStatus } from '../types';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/deepLinks';
import { generatePairingCode, pairingCodeToString } from '../setup/self-host';
import { priceRegistry } from '../pricing/registry';
import { crowdsourcedAdapter } from '../pricing/crowdsourced';
import { instacartAdapter } from '../pricing/instacart';
import { scrapingAdapter } from '../pricing/scraping';
import QRCode from '../components/QRCode';
import ContributeConsentModal from '../components/ContributeConsentModal';
import { useShareInvite } from '../hooks/useShareInvite';
import { friendlyError } from '../utils/friendlyError';
import { useThemeStore, useActiveTheme } from '../state/useThemeStore';
import {
  useEntitlementStore,
  purchasePlus,
  restorePlus,
  PLUS_PAYWALL_COPY,
  PLUS_PRICE_DISPLAY,
} from '../config/entitlements';

import { themeColors } from '../components/groceryTheme';

/**
 * The paid "Managed" hosting tier is hidden in v1: there is no in-app way to
 * purchase it, and Apple 3.1.1 requires digital services sold for use in-app
 * to go through In-App Purchase — an un-buyable "subscription key" field is a
 * rejection magnet. v1 ships self-hosted-only. Re-enable together with real
 * IAP (see docs/MONETIZATION.md); the settings field and tier plumbing are
 * kept intact underneath.
 */
const MANAGED_TIER_ENABLED = false;

/**
 * Cloud voice-assistant linking (Alexa / Google Assistant) is disabled in v1.
 *
 * The relay-custody flaw is fixed: the relay no longer holds the assistant
 * private key, so it can't decrypt the sealed family key (see
 * assistant-keygen.js / ARCHITECTURE-VOICE-ASSISTANTS.md). But linking still
 * sends list contents to a webhook that decrypts them to answer voice
 * requests — inherent to cloud voice. Before flipping this on: deploy the
 * webhook, add an explicit in-app disclosure, update the privacy labels/data-
 * safety forms, and set ASSISTANT_INTEGRATION=true on the relay. See
 * docs/MONETIZATION.md. Siri stays fully on-device and is unaffected.
 */
const VOICE_ASSISTANT_LINKING_ENABLED = false;

// ─── Segmented Control ───────────────────────────────────────────────────────

interface SegmentedControlProps {
  options: { label: string; value: string }[];
  selected: string;
  onSelect: (value: string) => void;
  theme: typeof themeColors.light;
}

function SegmentedControl({ options, selected, onSelect, theme }: SegmentedControlProps) {
  return (
    <View style={[styles.segmentedControl, { backgroundColor: theme.segmentedBg }]}>
      {options.map((opt) => {
        const isActive = selected === opt.value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={[
              styles.segmentButton,
              isActive && { backgroundColor: theme.segmentActiveBg },
            ]}
            onPress={() => onSelect(opt.value)}
          >
            <Text
              style={[
                styles.segmentText,
                { color: isActive ? '#fff' : theme.secondaryText },
                isActive && styles.segmentTextActive,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Settings Row ────────────────────────────────────────────────────────────

interface SettingsRowProps {
  label: string;
  value?: string;
  onChangeText?: (text: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'url' | 'numeric';
  theme: typeof themeColors.light;
  isDark: boolean;
}

function SettingsRow({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  theme,
  isDark,
}: SettingsRowProps) {
  return (
    <View style={styles.settingsRow}>
      <Text style={[styles.settingsLabel, { color: theme.secondaryText }]}>{label}</Text>
      {onChangeText ? (
        <TextInput
          style={[
            styles.settingsInput,
            {
              backgroundColor: isDark ? '#0B0F19' : '#FAFAFA',
              color: theme.text,
              borderColor: theme.border,
            },
          ]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={isDark ? '#475569' : '#999'}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType ?? 'default'}
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : (
        <Text style={[styles.settingsValue, { color: theme.text }]} selectable>
          {value ?? '-'}
        </Text>
      )}
    </View>
  );
}

// ─── Toggle Row ──────────────────────────────────────────────────────────────

interface ToggleRowProps {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  theme: typeof themeColors.light;
}

function ToggleRow({ label, value, onValueChange, disabled, theme }: ToggleRowProps) {
  return (
    <View style={styles.toggleRow}>
      <Text style={[styles.toggleLabel, { color: theme.text }, disabled && styles.disabled]}>
        {label}
      </Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: theme.border, true: '#10B981' }}
        thumbColor={value ? '#fff' : '#f4f3f4'}
      />
    </View>
  );
}

// ─── Main Screen ─────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export default function SettingsScreen({ navigation }: Props) {
  const [settings, setSettingsState] = useState<AppSettings | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected');
  const [testingConnection, setTestingConnection] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Adapter toggle states
  const [crowdEnabled, setCrowdEnabled] = useState(true);
  const [instacartEnabled, setInstacartEnabled] = useState(true);
  const [scrapingEnabled, setScrapingEnabled] = useState(false);
  // Pricing opt-in state
  const [pricingOptedIn, setPricingOptedIn] = useState(false);
  const [pricingDisclosureShown, setPricingDisclosureShown] = useState(false);
  // Contribution state (Stage 3)
  const [contributeEnabled, setContributeEnabled] = useState(false);
  const [contributeStoreGranularity, setContributeStoreGranularity] = useState<'region' | 'branch'>('region');
  const [contributeConsentShown, setContributeConsentShown] = useState(false);
  const [showContributeConsent, setShowContributeConsent] = useState(false);

  const { shareInvite } = useShareInvite();

  const [voicePairingCode, setVoicePairingCode] = useState('');
  const [linkingVoice, setLinkingVoice] = useState(false);

  // PantryRun Plus (entitlement computed solely in src/config/entitlements.ts)
  const isPlus = useEntitlementStore((s) => s.isPlus);
  const plusBusy = useEntitlementStore((s) => s.busy);

  const getRelayHttpUrl = useCallback(() => {
    if (!settings) return '';
    const proto = settings.relayUrl.startsWith('wss:') ? 'https:' : 'http:';
    const host = settings.relayUrl.replace(/^wss?:\/\//, '');
    return `${proto}//${host}:${settings.relayPort}`;
  }, [settings]);

  const handleLinkVoice = useCallback(async () => {
    if (!voicePairingCode || voicePairingCode.length !== 6) {
      Alert.alert('Error', 'Please enter a valid 6-digit code.');
      return;
    }

    setLinkingVoice(true);

    try {
      // 1. Get family ID and master key
      const { getFamilyId } = await import('../identity/family');
      const familyId = await getFamilyId();
      if (!familyId) {
        Alert.alert('Error', 'You must be in a family to link a voice assistant.');
        setLinkingVoice(false);
        return;
      }

      const { getMasterKey, encryptMasterKeyWithAssistantPublicKey } = await import('../crypto');
      const masterKey = await getMasterKey();
      if (!masterKey) {
        Alert.alert('Error', 'Master key is not available. Please unlock your app first.');
        setLinkingVoice(false);
        return;
      }

      // 2. Fetch assistant public key from relay
      const httpUrl = getRelayHttpUrl();
      const pubKeyRes = await fetch(`${httpUrl}/api/assistant/public-key`, {
        signal: AbortSignal.timeout(10_000)
      });
      if (!pubKeyRes.ok) {
        throw new Error(`Failed to fetch assistant public key (${pubKeyRes.status})`);
      }
      const publicKeyPem = await pubKeyRes.text();

      // 3. Encrypt the family master key with the assistant's public key
      const encryptedMasterKey = await encryptMasterKeyWithAssistantPublicKey(
        masterKey,
        publicKeyPem
      );

      // 4. Submit pairing to relay server
      const pairRes = await fetch(`${httpUrl}/api/oauth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairingCode: voicePairingCode,
          familyId,
          encryptedMasterKey
        }),
        signal: AbortSignal.timeout(10_000)
      });

      if (!pairRes.ok) {
        const errText = await pairRes.text().catch(() => '');
        throw new Error(`Pairing failed: ${errText || pairRes.status}`);
      }

      Alert.alert(
        'Linking Successful',
        'Your voice assistant has been securely linked! You can now use Alexa or Google Assistant to manage your grocery list.',
        [{ text: 'OK', onPress: () => setVoicePairingCode('') }]
      );
    } catch (err) {
      console.error('[SettingsScreen:LinkVoice]', err);
      Alert.alert('Error Linking Assistant', err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingVoice(false);
    }
  }, [settings, voicePairingCode, getRelayHttpUrl]);

  // Theme support
  const themeMode = useThemeStore((s) => s.themeMode);
  const setThemeMode = useThemeStore((s) => s.setThemeMode);
  const activeTheme = useActiveTheme();
  const isDark = activeTheme === 'dark';
  const theme = isDark ? themeColors.dark : themeColors.light;

  // Load settings on mount
  useEffect(() => {
    (async () => {
      await initSettings();
      const s = getSettings();
      setSettingsState(s);
      setPricingOptedIn(s.pricingOptedIn);
      setContributeEnabled(s.contributeEnabled ?? false);
      setContributeStoreGranularity(s.contributeStoreGranularity ?? 'region');
      setContributeConsentShown(s.contributeConsentShown ?? false);
      setLoaded(true);
    })();
  }, []);

  // Update handler
  const handleUpdate = useCallback(async (partial: Partial<AppSettings>) => {
    const updated = await updateSettings(partial);
    setSettingsState(updated);
  }, []);

  // Tier switch handler
  const handleTierChange = useCallback(
    async (tier: string) => {
      const updated = await setHostingTier(tier as HostingTier);
      setSettingsState(updated);
    },
    [],
  );

  // Test connection handler
  const handleTestConnection = useCallback(async () => {
    if (!settings) return;
    setTestingConnection(true);
    setConnectionStatus('connecting');

    const ok = await testRelayConnection(settings.relayUrl, settings.relayPort);

    if (ok) {
      setConnectionStatus('connected');
      Alert.alert('Connection Successful', 'Relay server is reachable.');
    } else {
      setConnectionStatus('error');
      Alert.alert(
        'Connection Failed',
        'Could not reach the relay server. Check the URL and port.',
      );
    }

    setTestingConnection(false);
  }, [settings]);

  if (!loaded || !settings) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.bg }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.secondaryText }]}>Loading settings...</Text>
      </View>
    );
  }

  const deviceId = getDeviceId();
  // With the managed tier hidden, everyone gets the self-hosted experience —
  // including anyone whose stored settings still say 'managed'.
  const isSelfHosted = !MANAGED_TIER_ENABLED || settings.hostingTier === 'self_hosted';

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={styles.headerBar}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={[styles.backText, { color: theme.primary }]}>← Back</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>Settings</Text>
      </View>

      {/* ── Tier Selector (hidden in v1 — see MANAGED_TIER_ENABLED) ──── */}
      {MANAGED_TIER_ENABLED && (
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Hosting Tier</Text>
        <SegmentedControl
          options={[
            { label: 'Self-Hosted', value: 'self_hosted' },
            { label: 'Managed', value: 'managed' },
          ]}
          selected={settings.hostingTier}
          onSelect={handleTierChange}
          theme={theme}
        />
      </View>
      )}

      {/* ── Appearance Selector ─────────────────────────────────────────── */}
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Appearance</Text>
        <SegmentedControl
          options={[
            { label: 'System Default', value: 'system' },
            { label: 'Light Mode', value: 'light' },
            { label: 'Dark Mode', value: 'dark' },
          ]}
          selected={themeMode}
          onSelect={(v) => setThemeMode(v as any)}
          theme={theme}
        />
      </View>

      {/* ── Device Info ──────────────────────────────────────────────── */}
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Device</Text>
        <SettingsRow label="Device ID" value={deviceId} theme={theme} isDark={isDark} />
      </View>

      {/* ── Relay Configuration ──────────────────────────────────────── */}
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Relay Server</Text>

        <SettingsRow
          label="WebSocket URL"
          value={settings.relayUrl}
          onChangeText={(v) => handleUpdate({ relayUrl: v })}
          placeholder="ws://localhost"
          keyboardType="url"
          theme={theme}
          isDark={isDark}
        />

        <SettingsRow
          label="Port"
          value={String(settings.relayPort)}
          onChangeText={(v) =>
            handleUpdate({ relayPort: parseInt(v, 10) || 8080 })
          }
          placeholder="8080"
          keyboardType="numeric"
          theme={theme}
          isDark={isDark}
        />

        <TouchableOpacity
          style={[
            styles.testButton,
            testingConnection && styles.testButtonDisabled,
            connectionStatus === 'connected' && styles.testButtonSuccess,
            connectionStatus === 'error' && styles.testButtonError,
          ]}
          onPress={handleTestConnection}
          disabled={testingConnection}
        >
          {testingConnection ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.testButtonText}>
              {connectionStatus === 'connected'
                ? '✓ Connected'
                : connectionStatus === 'error'
                  ? '✗ Retry Connection'
                  : 'Test Connection'}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {/* ── Self-Hosted: Pairing Code ────────────────────────────────── */}
      {isSelfHosted && (
        <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Pairing Code</Text>
          <Text style={[styles.sectionDescription, { color: theme.secondaryText }]}>
            Share this code with other family members to pair with your
            self-hosted relay.
          </Text>
          <Text style={[styles.pairingCodeBox, { backgroundColor: isDark ? '#0B0F19' : '#f0f0f0', color: theme.text }]}>
            {settings.pairingCode || 'Generate pairing code from setup screen'}
          </Text>
          <TouchableOpacity
            style={[styles.generateQrBtn, { backgroundColor: theme.primary }]}
            onPress={async () => {
              try {
                const { createFamilyInviteLink } = await import('../identity/invite-link');
                const { token, selfEnrollFailed } = await createFamilyInviteLink();
                await updateSettings({ pairingCode: token });
                setSettingsState((prev) => prev ? { ...prev, pairingCode: token } : prev);
                Alert.alert(
                  'Invite ready',
                  'Valid for 7 days, one join per code. The new member also needs your family recovery phrase to unlock shared lists — show it now so you can share both together.' +
                    (selfEnrollFailed
                      ? '\n\n⚠️ This device could not connect to sync just now — regenerate the invite when your server is reachable, or your own edits will not sync.'
                      : ''),
                  [
                    { text: 'Later', style: 'cancel' },
                    {
                      text: 'Show recovery phrase',
                      onPress: () => navigation.navigate('Recovery', { mode: 'show' }),
                    },
                  ],
                );
              } catch (err) {
                Alert.alert('Could not create invite', friendlyError(err, 'Please try again.'));
              }
            }}
          >
            <Text style={styles.generateQrBtnText}>Generate QR Code</Text>
          </TouchableOpacity>
          {settings.pairingCode && (
            <View style={styles.qrCodeContainer}>
              <Text style={[styles.qrCodeLabel, { color: theme.secondaryText }]}>Scan to join your family list</Text>
              <QRCode
                data={`groceryapp://invite?token=${encodeURIComponent(settings.pairingCode)}`}
                size={180}
                testID="pairing-qr-code"
              />
              <Text style={[styles.qrCodeData, { color: theme.secondaryText }]} selectable numberOfLines={3}>
                {settings.pairingCode}
              </Text>
              <TouchableOpacity
                style={styles.shareInviteBtn}
                onPress={() =>
                  shareInvite(
                    `groceryapp://invite?token=${encodeURIComponent(settings.pairingCode)}`,
                  )
                }
              >
                <Text style={styles.shareInviteBtnText}>Share Invite</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* ── Managed Tier: Subscription ───────────────────────────────── */}
      {!isSelfHosted && (
        <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Managed Subscription</Text>
          <SettingsRow
            label="Subscription Key"
            value={settings.managedSubscriptionKey}
            onChangeText={(v) => handleUpdate({ managedSubscriptionKey: v })}
            placeholder="Enter your subscription key"
            secureTextEntry
            theme={theme}
            isDark={isDark}
          />
          <Text style={[styles.planInfo, { color: theme.secondaryText }]}>
            Plan: Managed Relay + Encrypted Sync
          </Text>
          <Text style={[styles.tierDescription, { color: theme.secondaryText }]}>
            Managed: Price queries are anonymized through our relay. Item names are hashed.
          </Text>
        </View>
      )}

      {/* ── Local AI Endpoint (Self-Hosted Only) ─────────────────────── */}
      {isSelfHosted && (
        <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>AI Endpoint</Text>
          <SettingsRow
            label="Local AI URL"
            value={settings.localAiEndpoint}
            onChangeText={(v) => handleUpdate({ localAiEndpoint: v })}
            placeholder="http://localhost:1234"
            keyboardType="url"
            theme={theme}
            isDark={isDark}
          />
        </View>
      )}

      {/* ── Opt-In Features ──────────────────────────────────────────── */}
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Features</Text>

        <ToggleRow
          label="Price Service"
          value={settings.priceServiceEnabled}
          onValueChange={(v) => handleUpdate({ priceServiceEnabled: v })}
          theme={theme}
        />

        {/* Pricing Opt-In Toggle with Privacy Disclosure */}
        <ToggleRow
          label="Pricing Lookups (Opt-In)"
          value={pricingOptedIn}
          onValueChange={async (v) => {
            if (v && !pricingDisclosureShown) {
              setPricingDisclosureShown(true);
              Alert.alert(
                'Privacy Disclosure',
                'Enabling pricing matches your grocery list against locally stored prices — from flyers you scan and prices you enter. In this version, your item names never leave this device. Your shopping habits are not tracked or stored. You can disable this anytime.',
                [
                  { text: 'Cancel', style: 'cancel', onPress: () => {
                    setPricingDisclosureShown(false);
                    setPricingOptedIn(false);
                  }},
                  {
                    text: 'Enable',
                    onPress: async () => {
                      setPricingOptedIn(true);
                      await handleUpdate({ pricingOptedIn: true } as any);
                    },
                  },
                ],
              );
            } else {
              setPricingOptedIn(v);
              await handleUpdate({ pricingOptedIn: v } as any);
            }
          }}
          theme={theme}
        />
        {pricingOptedIn && (
          <Text style={[styles.privacyNote, { color: theme.secondaryText }]}>
            Price matching happens on this device against your local price list. Item names are not sent to any server in this version.
          </Text>
        )}
        {/* Barcode Lookups: gates the Open Food Facts lookup that names
            scanned products. Consent is normally granted via the inline
            prompt at the scanner; this toggle is the persistent off switch
            the privacy policy promises. (Voice Input toggle stays removed:
            voice is an on-device text modal, nothing to gate.) */}
        <ToggleRow
          label="Barcode Lookups (Opt-In)"
          value={(settings as any).barcodeScanningEnabled ?? false}
          onValueChange={(v) => handleUpdate({ barcodeScanningEnabled: v } as any)}
          theme={theme}
        />
        {((settings as any).barcodeScanningEnabled ?? false) && (
          <Text style={[styles.privacyNote, { color: theme.secondaryText }]}>
            Scanned barcode numbers are sent to the Open Food Facts public database to fetch product names. Nothing else is sent.
          </Text>
        )}
      </View>

      {/* ── Voice Assistant Linking (disabled in v1 — see flag at top) ── */}
      {VOICE_ASSISTANT_LINKING_ENABLED && (
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Voice Assistant Link</Text>
        <Text style={[styles.sectionDescription, { color: theme.secondaryText }]}>
          Link Amazon Alexa or Google Assistant to add/check-off items on your list using your voice.
        </Text>
        
        <SettingsRow
          label="6-Digit Code"
          value={voicePairingCode}
          onChangeText={(v) => setVoicePairingCode(v.replace(/[^0-9]/g, '').slice(0, 6))}
          placeholder="Enter pairing code"
          keyboardType="numeric"
          theme={theme}
          isDark={isDark}
        />

        <TouchableOpacity
          style={[
            styles.voiceLinkButton,
            { backgroundColor: theme.primary },
            (voicePairingCode.length !== 6 || linkingVoice) && styles.voiceLinkButtonDisabled
          ]}
          onPress={handleLinkVoice}
          disabled={voicePairingCode.length !== 6 || linkingVoice}
        >
          {linkingVoice ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.voiceLinkButtonText}>Link Assistant</Text>
          )}
        </TouchableOpacity>
      </View>
      )}

      {/* ── PantryRun Plus ────────────────────────────────────────────────── */}
      {/* PantryRun Plus. Entitlement state is computed ONLY in
          src/config/entitlements.ts; this section reads the store and routes
          purchase/restore to it. This replaces the old MANAGED_TIER
          subscription-key field — the two must never ship together
          (Guideline 3.1.1: no dead purchase path). */}
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>PantryRun Plus</Text>
        {isPlus ? (
          <Text style={[styles.sectionDescription, { color: theme.secondaryText }]}>
            ✨ Plus is active for your family. Trip Optimizer is unlocked on
            every family device.
          </Text>
        ) : (
          <>
            <Text style={[styles.sectionDescription, { color: theme.secondaryText }]}>
              {PLUS_PAYWALL_COPY}
            </Text>
            <TouchableOpacity
              style={[styles.securityButton, { backgroundColor: theme.primary }, plusBusy && { opacity: 0.5 }]}
              disabled={plusBusy}
              onPress={() => {
                purchasePlus().then((ok) => {
                  if (!ok) {
                    const err = useEntitlementStore.getState().lastError;
                    if (err) Alert.alert('Purchase failed', err);
                  }
                });
              }}
            >
              <Text style={styles.securityButtonText}>
                ✨ Subscribe • {PLUS_PRICE_DISPLAY}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.securityButton, styles.securityButtonSecondary, plusBusy && { opacity: 0.5 }]}
              disabled={plusBusy}
              onPress={() => {
                restorePlus().then((ok) => {
                  if (!ok) {
                    const err = useEntitlementStore.getState().lastError;
                    if (err) Alert.alert('Restore failed', err);
                  }
                });
              }}
            >
              <Text style={styles.securityButtonTextSecondary}>
                ↺ Restore Purchase
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Security */}
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Security</Text>
        <Text style={[styles.sectionDescription, { color: theme.secondaryText }]}>
          Manage your recovery phrase and key backup options.
        </Text>

        <TouchableOpacity
          style={[styles.securityButton, { backgroundColor: theme.primary }]}
          onPress={() => {
            Alert.alert(
              'View Recovery Phrase',
              'Your recovery phrase gives access to your family data. Only view this in a private setting.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'View Phrase',
                  onPress: () => navigation.navigate('Recovery', { mode: 'show' }),
                },
              ],
            );
          }}
        >
          <Text style={styles.securityButtonText}>
            🔐 View Recovery Phrase
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.securityButton, styles.securityButtonSecondary]}
          onPress={() =>
            navigation.navigate('Recovery', { mode: 'recover' })
          }
        >
          <Text style={styles.securityButtonTextSecondary}>
            🔑 Recover from Backup
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.securityButton, { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#f44336' }]}
          onPress={() => {
            Alert.alert(
              'Leave Family',
              'This unpairs the device: your family membership and relay enrollment are removed, and syncing stops.\n\n' +
                'Grocery data already on this device stays here (delete lists or uninstall the app to remove it). ' +
                'Other family members keep their copies.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Leave Family',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      const { leaveFamily } = await import('../identity/family');
                      const { clearRelayCredentials } = await import('../identity/enroll');
                      const { syncManager } = await import('../sync/sync-manager');
                      syncManager.disconnect();
                      await leaveFamily();
                      await clearRelayCredentials();
                      Alert.alert(
                        'Left Family',
                        'This device is no longer paired. You can join a family again anytime from the pairing screen.',
                      );
                    } catch (err) {
                      Alert.alert('Error', err instanceof Error ? err.message : String(err));
                    }
                  },
                },
              ],
            );
          }}
        >
          <Text style={[styles.securityButtonTextSecondary, { color: '#f44336' }]}>
            🚪 Leave Family (Unpair Device)
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Privacy ──────────────────────────────────────────────────────── */}
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Privacy</Text>
        <Text style={[styles.sectionDescription, { color: theme.secondaryText }]}>
          View how PantryRun handles your data, manage privacy controls, and access legal documents.
        </Text>
        <TouchableOpacity
          style={[styles.securityButton, { backgroundColor: '#6366F1' }]}
          onPress={() => navigation.navigate('Privacy')}
        >
          <Text style={styles.securityButtonText}>
            🔒 Privacy Settings
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Pricing Subsystem ──────────────────────────────────────────── */}
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Pricing</Text>

        {isSelfHosted && (
          <Text style={[styles.pricingNote, { color: theme.primary }]}>
            Self-host: All price lookups stay local. No data leaves your network.
          </Text>
        )}

        <ToggleRow
          label="Use community flyer prices"
          value={settings.cloudFlyerEnabled ?? false}
          onValueChange={(v) => handleUpdate({ cloudFlyerEnabled: v })}
          theme={theme}
        />
        {settings.cloudFlyerEnabled && (
          <Text style={[styles.privacyNote, { color: theme.secondaryText }]}>
            Prices from the community flyer pool — anonymized and aggregated.
          </Text>
        )}

        <ToggleRow
          label="Contribute my scans"
          value={contributeEnabled}
          onValueChange={async (v) => {
            if (v && !contributeConsentShown) {
              setShowContributeConsent(true);
            } else {
              setContributeEnabled(v);
              await handleUpdate({ contributeEnabled: v } as any);
            }
          }}
          theme={theme}
        />
        {contributeEnabled && (
          <Text style={[styles.privacyNote, { color: theme.secondaryText }]}>
            Anonymized scan prices are shared to help others. Your identity is never included.
          </Text>
        )}

        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: theme.text }]}>Crowd-Sourced</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 11, color: '#10B981' }}>● Active</Text>
            <Switch
              value={crowdEnabled}
              onValueChange={async (v) => {
                setCrowdEnabled(v);
                await priceRegistry.setAdapterEnabled('crowdsourced', v);
              }}
              trackColor={{ false: theme.border, true: '#10B981' }}
              thumbColor={crowdEnabled ? '#fff' : '#f4f3f4'}
            />
          </View>
        </View>

        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: theme.text }]}>Instacart</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{
              fontSize: 11,
              color: instacartAdapter.isAvailable() ? '#10B981' : theme.secondaryText,
            }}>
              {instacartAdapter.isAvailable() ? '● Connected' : '○ Not configured'}
            </Text>
            <Switch
              value={instacartEnabled}
              onValueChange={async (v) => {
                setInstacartEnabled(v);
                await priceRegistry.setAdapterEnabled('instacart', v);
              }}
              trackColor={{ false: theme.border, true: '#10B981' }}
              thumbColor={instacartEnabled ? '#fff' : '#f4f3f4'}
            />
          </View>
        </View>

        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: theme.text }, !isSelfHosted && styles.disabled]}>
            Scraping (Self-Host Only)
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 11, color: theme.secondaryText }}>
              {scrapingEnabled ? '● On' : '○ Off'}
            </Text>
            <Switch
              value={scrapingEnabled && isSelfHosted}
              onValueChange={async (v) => {
                if (v && !isSelfHosted) {
                  Alert.alert(
                    'Restricted',
                    'Web scraping is only available in self-hosted mode.',
                  );
                  return;
                }
                setScrapingEnabled(v);
                await priceRegistry.setAdapterEnabled('scraping', v);
                await handleUpdate({ scrapingEnabled: v } as any);
              }}
              disabled={!isSelfHosted}
              trackColor={{ false: theme.border, true: '#FF9800' }}
              thumbColor={scrapingEnabled && isSelfHosted ? '#fff' : '#f4f3f4'}
            />
          </View>
        </View>

        {/* ── Flipp Deal Matching ─────────────────────────────────────────
            The Turso URL/token inputs and enabled toggle that used to live
            here were removed for v1: a user-pasted database credential is a
            client-held secret, and the Turso-backed deals/price surfaces are
            gated off entirely (Option B — see GOAL_PROMPT_NOTES.md). Only the
            non-credential FSA and flyer-scan preferences remain. */}
        <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Flipp Deal Matching</Text>
          <Text style={[styles.sectionDescription, { color: theme.secondaryText }]}>
            Your FSA (first 3 characters of your postal code) determines which
            local flyer deals to use.
          </Text>

          <SettingsRow
            label="Your FSA (postal code prefix)"
            value={(settings as any).flippFsa}
            onChangeText={(v) => handleUpdate({ flippFsa: v.toUpperCase().slice(0, 3) } as any)}
            placeholder="L0R"
            theme={theme}
            isDark={isDark}
          />

          <ToggleRow
            label="Flipp Flyer Deals"
            value={settings.flyerScanEnabled ?? false}
            onValueChange={(v) => handleUpdate({ flyerScanEnabled: v })}
            theme={theme}
          />
        </View>

        {/* Clear local price database */}
        <TouchableOpacity
          style={[styles.clearPricesBtn, { borderColor: '#f44336' }]}
          onPress={() => {
            Alert.alert(
              'Clear Price Data',
              'Remove all locally submitted crowd-sourced prices?',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Clear',
                  style: 'destructive',
                  onPress: async () => {
                    crowdsourcedAdapter.clearAllPrices();
                    const { flyerScanAdapter } = await import('../pricing/flyer-scan');
                    flyerScanAdapter.clearAllPrices();
                    const { usePriceStore } = await import('../pricing/price-store');
                    usePriceStore.getState().clearPrices();
                    usePriceStore.getState().clearPerStorePrices();
                    Alert.alert('Done', 'Local price data cleared.');
                  },
                },
              ],
            );
          }}
        >
          <Text style={styles.clearPricesText}>Clear Local Prices</Text>
        </TouchableOpacity>
      </View>

      {/* ── Danger Zone: Delete All Data (store-required deletion path) ── */}
      <View style={[styles.section, { backgroundColor: theme.cardBg, borderColor: '#f44336' }]}>
        <Text style={[styles.sectionTitle, { color: '#f44336' }]}>Danger Zone</Text>
        <Text style={[styles.sectionDescription, { color: theme.secondaryText }]}>
          Attempt to delete local lists, settings, encryption keys, and device identity this install can address. Some secure-storage entries may remain.
        </Text>
        <TouchableOpacity
          style={[styles.clearPricesBtn, { borderColor: '#f44336', backgroundColor: '#f44336' }]}
          accessibilityRole="button"
          accessibilityLabel="Delete all data"
          onPress={() => {
            Alert.alert(
              'Delete All Data?',
              'This attempts to delete local grocery lists, settings, and encryption keys this install can address. Without your 12-word recovery phrase (or another family device), deleted data is UNRECOVERABLE — there is no account and no server-side reset. This does not erase copies on other family devices or your relay. Forgotten recovery or passkey entries may remain in secure storage.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete Everything',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      const { deleteAllLocalData } = await import('../services/dataWipe');
                      const result = await deleteAllLocalData();
                      const failed = Object.keys(result.errors);
                      if (failed.length === 0) {
                        Alert.alert(
                          'Local Deletion Finished',
                          'The app finished its local deletion steps. Some secure-storage cleanup failures may not be reported, and forgotten recovery or passkey entries may remain. Copies on other family devices or your relay were not erased. Restart the app to start fresh.',
                        );
                      } else {
                        Alert.alert(
                          'Deleted With Warnings',
                          `Some local data or encryption keys may remain because these steps failed: ${failed.join(', ')}. Restart the app and retry deletion. Copies on other family devices or your relay were not erased.`,
                        );
                      }
                    } catch (err) {
                      Alert.alert('Delete Failed', err instanceof Error ? err.message : 'Please try again.');
                    }
                  },
                },
              ],
            );
          }}
        >
          <Text style={[styles.clearPricesText, { color: '#fff' }]}>Delete All Data</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.bottomSpacer} />

      {/* ── Contribute Consent Modal ──────────────────────────────── */}
      <ContributeConsentModal
        visible={showContributeConsent}
        onConfirm={async (granularity) => {
          setContributeStoreGranularity(granularity);
          setContributeConsentShown(true);
          setContributeEnabled(true);
          setShowContributeConsent(false);
          await handleUpdate({
            contributeEnabled: true,
            contributeStoreGranularity: granularity,
            contributeConsentShown: true,
          } as any);
        }}
        onCancel={() => {
          setShowContributeConsent(false);
          setContributeConsentShown(true);
          handleUpdate({ contributeConsentShown: true } as any);
        }}
        onSkip={() => {
          setShowContributeConsent(false);
          setContributeConsentShown(true);
          handleUpdate({ contributeConsentShown: true } as any);
        }}
      />
    </ScrollView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#666',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#333',
    padding: 20,
    paddingBottom: 8,
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
    marginBottom: 12,
  },
  sectionDescription: {
    fontSize: 13,
    color: '#666',
    marginBottom: 8,
    lineHeight: 18,
  },
  settingsRow: {
    marginBottom: 12,
  },
  settingsLabel: {
    fontSize: 13,
    color: '#666',
    marginBottom: 4,
  },
  settingsInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    color: '#333',
    backgroundColor: '#fafafa',
  },
  settingsValue: {
    fontSize: 13,
    color: '#555',
    fontFamily: 'monospace',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  toggleLabel: {
    fontSize: 15,
    color: '#333',
  },
  disabled: {
    opacity: 0.4,
  },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: '#eee',
    borderRadius: 8,
    padding: 2,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 6,
  },
  segmentButtonActive: {
    backgroundColor: '#4CAF50',
  },
  segmentText: {
    fontSize: 14,
    color: '#666',
    fontWeight: '500',
  },
  segmentTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  testButton: {
    backgroundColor: '#2196F3',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  testButtonDisabled: {
    opacity: 0.6,
  },
  testButtonSuccess: {
    backgroundColor: '#4CAF50',
  },
  testButtonError: {
    backgroundColor: '#f44336',
  },
  testButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  pairingCodeBox: {
    backgroundColor: '#f0f0f0',
    padding: 12,
    borderRadius: 8,
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#333',
    lineHeight: 16,
  },
  generateQrBtn: {
    backgroundColor: '#4CAF50',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  generateQrBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  qrCodeContainer: {
    marginTop: 12,
    alignItems: 'center',
  },
  qrCodeLabel: {
    fontSize: 12,
    color: '#999',
    marginBottom: 8,
  },
  qrCodeBox: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    alignItems: 'center',
  },
  qrCodeText: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: '#333',
    lineHeight: 14,
    letterSpacing: 1,
  },
  qrCodeData: {
    fontSize: 9,
    color: '#999',
    marginTop: 8,
    textAlign: 'center',
    fontFamily: 'monospace',
  },
  shareInviteBtn: {
    backgroundColor: '#2196F3',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  shareInviteBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  planInfo: {
    fontSize: 13,
    color: '#666',
    marginTop: 4,
    fontStyle: 'italic',
  },
  bottomSpacer: {
    height: 40,
  },
  clearPricesBtn: {
    marginTop: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#f44336',
  },
  clearPricesText: {
    fontSize: 13,
    color: '#f44336',
    fontWeight: '600',
  },
  securityButton: {
    backgroundColor: '#4CAF50',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  securityButtonSecondary: {
    backgroundColor: '#FF9800',
  },
  securityButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  securityButtonTextSecondary: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  privacyNote: {
    fontSize: 12,
    color: '#888',
    fontStyle: 'italic',
    marginBottom: 8,
    marginTop: -4,
    lineHeight: 16,
  },
  tierDescription: {
    fontSize: 12,
    color: '#888',
    fontStyle: 'italic',
    marginTop: 4,
    lineHeight: 16,
  },
  pricingNote: {
    fontSize: 12,
    color: '#4CAF50',
    fontWeight: '500',
    marginBottom: 8,
    lineHeight: 16,
  },
  voiceLinkButton: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  voiceLinkButtonDisabled: {
    opacity: 0.5,
  },
  voiceLinkButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
