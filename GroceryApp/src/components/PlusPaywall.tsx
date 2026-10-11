/**
 * PlusPaywall — the one place PantryRun Plus is sold (Settings and the
 * Trip Optimizer upsell both open it).
 *
 * Apple Guideline 3.1.2 requires an auto-renewing subscription's purchase
 * screen to show the plan name, the localized price and period, the renewal
 * and cancellation terms, the account that is charged, how to manage/cancel,
 * and working links to the Terms of Use (EULA) and Privacy Policy, next to
 * Subscribe and Restore. A system Alert cannot carry that, which is why this
 * replaced the Alert-based upsell.
 *
 * Price and period come from the store (loadPlusProduct); PLUS_PRICE_DISPLAY
 * is shown only until the store answers. All copy lives in
 * src/config/plus-paywall.ts; entitlement state is read, never computed, here.
 *
 * Usage:
 *   <PlusPaywall visible={show} onClose={() => setShow(false)} />
 */

import React, { useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  Linking,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';

import { useActiveTheme } from '../state/useThemeStore';
import { themeColors } from './groceryTheme';
import {
  useEntitlementStore,
  purchasePlus,
  restorePlus,
  loadPlusProduct,
  PLUS_PAYWALL_COPY,
} from '../config/entitlements';
import {
  paywallPricing,
  paywallTerms,
  manageSubscriptionsUrl,
  storeAccountName,
  TERMS_OF_USE_URL,
  PRIVACY_POLICY_URL,
} from '../config/plus-paywall';

/** "$14.99/year" from the store once loaded, the fallback until then. */
export function usePlusPriceLabel(): string {
  const product = useEntitlementStore((s) => s.product);
  return paywallPricing(product).priceLabel;
}

/** Open the platform's own subscription-management page. */
export function openManageSubscriptions(): void {
  Linking.openURL(manageSubscriptionsUrl(Platform.OS)).catch(() => {
    Alert.alert(
      'Manage subscription',
      `Open your ${storeAccountName(Platform.OS)} subscription settings to manage or cancel PantryRun Plus.`,
    );
  });
}

function openLink(url: string): void {
  Linking.openURL(url).catch(() => Alert.alert('Could not open link', url));
}

interface PlusPaywallProps {
  visible: boolean;
  onClose: () => void;
}

export default function PlusPaywall({ visible, onClose }: PlusPaywallProps) {
  const activeTheme = useActiveTheme();
  const isDark = activeTheme === 'dark';
  const theme = isDark ? themeColors.dark : themeColors.light;

  const isPlus = useEntitlementStore((s) => s.isPlus);
  const busy = useEntitlementStore((s) => s.busy);
  const product = useEntitlementStore((s) => s.product);
  const pendingPayment = useEntitlementStore((s) => s.pendingPayment);

  useEffect(() => {
    if (visible && !product) void loadPlusProduct();
  }, [visible, product]);

  const pricing = paywallPricing(product);
  const terms = paywallTerms(Platform.OS, product);

  const handleSubscribe = () => {
    purchasePlus().then((ok) => {
      if (!ok) {
        const err = useEntitlementStore.getState().lastError;
        if (err) Alert.alert('Purchase failed', err);
      }
    });
  };

  const handleRestore = () => {
    restorePlus().then((ok) => {
      if (!ok) {
        const { lastError, pendingPayment: pending } = useEntitlementStore.getState();
        if (lastError && !pending) Alert.alert('Restore failed', lastError);
      }
    });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: theme.overlay }]}>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            <Text style={styles.icon}>✨</Text>
            <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
              PantryRun Plus
            </Text>
            <Text style={[styles.body, { color: theme.secondaryText }]}>{PLUS_PAYWALL_COPY}</Text>

            {/* Plan: name, localized price and period */}
            <View
              style={[styles.plan, { backgroundColor: theme.noteBg, borderColor: theme.noteBorder }]}
              accessibilityLabel={`${pricing.planName}, ${pricing.price} per ${pricing.period}, auto-renewing`}
            >
              <Text style={[styles.planName, { color: theme.text }]}>{pricing.planName}</Text>
              <View style={styles.priceRow}>
                <Text style={[styles.price, { color: theme.text }]}>{pricing.price}</Text>
                <Text style={[styles.period, { color: theme.secondaryText }]}> / {pricing.period}</Text>
                {!pricing.fromStore && (
                  <ActivityIndicator size="small" color={theme.secondaryText} style={styles.priceSpinner} />
                )}
              </View>
              <Text style={[styles.planNote, { color: theme.secondaryText }]}>
                Auto-renewing subscription · billed {pricing.renews}
                {!pricing.fromStore ? ' · loading your local price…' : ''}
              </Text>
            </View>

            {isPlus ? (
              <>
                <Text style={[styles.active, { color: theme.primary }]}>
                  ✨ Plus is active for your family.
                </Text>
                <TouchableOpacity
                  style={[styles.primaryButton, { backgroundColor: theme.primary }]}
                  onPress={onClose}
                  accessibilityRole="button"
                >
                  <Text style={[styles.primaryButtonText, { color: theme.primaryText }]}>Done</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                {pendingPayment && (
                  <View
                    style={[
                      styles.pending,
                      { backgroundColor: theme.unassignedBg, borderColor: theme.unassignedBorder },
                    ]}
                    accessibilityRole="alert"
                  >
                    <Text style={[styles.pendingText, { color: theme.unassignedText }]}>
                      ⏳ Payment pending. Your purchase is waiting for the store to confirm payment
                      (or for approval). Plus unlocks automatically as soon as it goes through — you
                      have not been charged twice and do not need to buy again.
                    </Text>
                  </View>
                )}
                <TouchableOpacity
                  style={[styles.primaryButton, { backgroundColor: theme.primary }, busy && styles.disabled]}
                  disabled={busy}
                  onPress={handleSubscribe}
                  accessibilityRole="button"
                  accessibilityLabel={`Subscribe for ${pricing.priceLabel}`}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={theme.primaryText} />
                  ) : (
                    <Text style={[styles.primaryButtonText, { color: theme.primaryText }]}>
                      Subscribe • {pricing.priceLabel}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.secondaryButton, { borderColor: theme.border }, busy && styles.disabled]}
                  disabled={busy}
                  onPress={handleRestore}
                  accessibilityRole="button"
                >
                  <Text style={[styles.secondaryButtonText, { color: theme.text }]}>
                    Restore Purchases
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {/* Auto-renewal disclosure */}
            {terms.map((t, i) => (
              <Text key={i} style={[styles.terms, { color: theme.secondaryText }]}>
                {t}
              </Text>
            ))}

            <TouchableOpacity onPress={openManageSubscriptions} accessibilityRole="link">
              <Text style={[styles.link, { color: theme.primary }]}>Manage subscription</Text>
            </TouchableOpacity>

            <View style={styles.legalRow}>
              <TouchableOpacity onPress={() => openLink(TERMS_OF_USE_URL)} accessibilityRole="link">
                <Text style={[styles.link, { color: theme.primary }]}>Terms of Use</Text>
              </TouchableOpacity>
              <Text style={[styles.legalSep, { color: theme.secondaryText }]}>·</Text>
              <TouchableOpacity onPress={() => openLink(PRIVACY_POLICY_URL)} accessibilityRole="link">
                <Text style={[styles.link, { color: theme.primary }]}>Privacy Policy</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.closeLink} onPress={onClose} accessibilityRole="button">
              <Text style={[styles.closeLinkText, { color: theme.secondaryText }]}>Not Now</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '92%',
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  scroll: {
    padding: 24,
    alignItems: 'center',
  },
  icon: {
    fontSize: 44,
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 16,
  },
  plan: {
    width: '100%',
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 16,
    alignItems: 'center',
  },
  planName: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
    textAlign: 'center',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  price: {
    fontSize: 28,
    fontWeight: '800',
  },
  period: {
    fontSize: 16,
  },
  priceSpinner: {
    marginLeft: 8,
  },
  planNote: {
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
  },
  active: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  pending: {
    width: '100%',
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
  },
  pendingText: {
    fontSize: 13,
    lineHeight: 18,
  },
  primaryButton: {
    width: '100%',
    minHeight: 48,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    width: '100%',
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.5,
  },
  terms: {
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 8,
    textAlign: 'left',
    alignSelf: 'stretch',
  },
  link: {
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
    paddingVertical: 6,
  },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  legalSep: {
    marginHorizontal: 10,
  },
  closeLink: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  closeLinkText: {
    fontSize: 14,
  },
});
