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

import { LogBox } from 'react-native';
LogBox.ignoreLogs([
  'Open debugger to view warnings',
  'ViewPropTypes',
  'ColorPropType',
  'EdgeInsetsPropType',
]);
if (!__DEV__) {
  LogBox.ignoreAllLogs(true);
}

import React, { useEffect, useState, useCallback, Suspense, lazy } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import ErrorBoundary from './src/components/ErrorBoundary';
import { useActiveTheme } from './src/state/useThemeStore';

// Static screen imports to avoid chunk loading failures in bare React Native CLI
import HomeScreen from './src/screens/HomeScreen';
import GroceryListScreen from './src/screens/GroceryListScreen';
import ItemEditScreen from './src/screens/ItemEditScreen';
import PairingScreen from './src/screens/PairingScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import RecoveryScreen from './src/screens/RecoveryScreen';
import PrivacyScreen from './src/screens/PrivacyScreen';
import { linkingConfig } from './src/navigation/deepLinks';

const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef();

function LoadingView() {
  return (
    <SafeAreaProvider>
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#7CB342" />
        <Text style={styles.loadingText}>Loading PantryRun...</Text>
      </View>
    </SafeAreaProvider>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [Screens, setScreens] = useState<any>(null);
  // Status-bar icons must contrast with the theme: light icons on dark, dark
  // icons on light. Previously hardcoded "light", so icons vanished in light mode.
  const activeTheme = useActiveTheme();
  const statusBarStyle = activeTheme === 'dark' ? 'light' : 'dark';

  const runInit = useCallback(() => {
    setError(null);
    async function init() {
      try {
        // 1. Init services (crypto, database)
        const crypto = await import('./src/crypto');
        await crypto.initCrypto();

        const database = await import('./src/storage/database');
        const db = database.getDatabase();
        await db.get('grocery_lists').query().fetchCount();

        // Load vector fonts dynamically
        const Font = await import('expo-font');
        const { Ionicons, Feather } = await import('@expo/vector-icons');
        await Font.loadAsync({
          ...Ionicons.font,
          ...Feather.font,
        });

        // Init device identity
        const device = await import('./src/identity/device');
        await device.initDeviceIdentity();

        // Init settings store (loads from SecureStore → populates cache).
        // Also purges any Turso credentials persisted by earlier versions.
        const { initSettings } = await import('./src/config/settings');
        await initSettings();

        // Turso is NOT initialized in v1. A read-write JWT was previously
        // committed in this file, and the later env-var fallback shipped the
        // same credential inside every release bundle. Any client-held Turso
        // credential is extractable from the built app, so v1 ships with the
        // Turso-backed deals/price surfaces gated off entirely (Option B —
        // see GOAL_PROMPT_NOTES.md). Post-v1 these features return through a
        // narrow relay-side endpoint whose credential never leaves the server.

        // Restore persisted lists into Yjs and connect family sync (if
        // enrolled). Without this call nothing ever hydrated from
        // WatermelonDB and the relay never connected.
        try {
          const { bootstrapSync } = await import('./src/sync/bootstrap');
          const mode = await bootstrapSync();
          console.log(`[init] Sync bootstrap: ${mode}`);
        } catch (e) {
          console.warn('[init] Sync bootstrap failed:', e);
        }

        // Resolve the PantryRun Plus entitlement (local table + family-doc
        // observer). Entitlement state is computed ONLY inside
        // src/config/entitlements.ts; everything else reads its store.
        try {
          const { resolveEntitlement, startEntitlementLifecycle } = await import('./src/config/entitlements');
          await resolveEntitlement();
          void startEntitlementLifecycle(); // store listener + launch/foreground re-check; never throws
        } catch (e) {
          console.warn('[init] Entitlement resolution failed:', e);
        }

        // Store branding comes from the static fallback maps in
        // src/pricing/store-branding.ts; the remote (Turso-backed) branding
        // fetch is gated off in v1 along with the rest of the Turso surface.

        // Init Sentry (respects user's sentryEnabled opt-out)
        try {
          const { initSentry } = await import('./src/services/sentry');
          await initSentry();
        } catch {
          // Sentry init failure is non-fatal
        }

        setScreens({
          Home: HomeScreen,
          GroceryList: GroceryListScreen,
          ItemEdit: ItemEditScreen,
          Pairing: PairingScreen,
          Settings: SettingsScreen,
          Recovery: RecoveryScreen,
          Privacy: PrivacyScreen,
          linkingConfig: linkingConfig,
        });
        setReady(true);
      } catch (err) {
        console.error('[init] Failed:', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    init();
  }, []);

  useEffect(() => {
    runInit();
  }, [runInit]);

  if (error) {
    return (
      <SafeAreaProvider>
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>PantryRun couldn't start</Text>
          <Text style={styles.errorMsg}>
            Something went wrong while getting things ready. This is usually
            temporary — please try again.
          </Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => {
              setShowErrorDetails(false);
              runInit();
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry starting the app"
          >
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowErrorDetails((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel="Show technical details"
          >
            <Text style={styles.detailsToggle}>
              {showErrorDetails ? 'Hide details' : 'Show details'}
            </Text>
          </TouchableOpacity>
          {showErrorDetails ? (
            <Text style={styles.errorDetails}>{error}</Text>
          ) : null}
        </View>
      </SafeAreaProvider>
    );
  }

  // 3D Motion Graphics Splash — shown before any other screen. The motion
  // sequence LOOPS while `ready` is false: on a first launch that covers the
  // whole account-creation flow (device keypair, family membership, recovery
  // phrase — all provisioned inside runInit → bootstrapSync). Once init has
  // settled the splash exits at its next scene boundary and calls onFinish.
  if (showSplash) {
    const SplashScreen = require('./src/screens/SplashScreen').default;
    return (
      <SafeAreaProvider>
        <SplashScreen canFinish={ready} onFinish={() => setShowSplash(false)} />
      </SafeAreaProvider>
    );
  }

  if (!ready || !Screens) return <LoadingView />;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <NavigationContainer
          ref={navigationRef}
          linking={Screens.linkingConfig}
          onReady={() => {
            // Wire notification taps → navigate to the relevant list.
            import('./src/navigation/useNotificationNavigation')
              .then(({ registerNotificationNavigation }) =>
                registerNotificationNavigation(navigationRef),
              )
              .catch(() => {});
          }}
        >
          <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
            <Stack.Screen name="Home" component={Screens.Home} />
            <Stack.Screen name="GroceryList" component={Screens.GroceryList} />
            <Stack.Screen name="ItemEdit" component={Screens.ItemEdit} />
            <Stack.Screen name="Pairing" component={Screens.Pairing} />
            <Stack.Screen name="Settings" component={Screens.Settings} />
            <Stack.Screen name="Privacy" component={Screens.Privacy} />
            <Stack.Screen name="Recovery" component={Screens.Recovery} />
          </Stack.Navigator>
        </NavigationContainer>
        <StatusBar style={statusBarStyle} />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FDF8F0' },
  loadingText: { color: '#1A1A1A', fontSize: 16, marginTop: 16 },
  errorTitle: { color: '#E53935', fontSize: 24, fontWeight: 'bold', marginBottom: 16 },
  errorMsg: { color: '#1A1A1A', fontSize: 16, textAlign: 'center', paddingHorizontal: 32 },
  retryBtn: { marginTop: 24, backgroundColor: '#10B981', paddingVertical: 12, paddingHorizontal: 32, borderRadius: 12 },
  retryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  detailsToggle: { color: '#6B7280', fontSize: 13, marginTop: 16, textDecorationLine: 'underline' },
  errorDetails: { color: '#6B7280', fontSize: 12, textAlign: 'center', paddingHorizontal: 32, marginTop: 8, fontFamily: 'System' },
});

export default App;
