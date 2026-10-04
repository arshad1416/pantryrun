/**
 * TripPlanSheet — bottom sheet showing the optimized trip plan.
 *
 * Displays:
 *  - Per-stop sections: store name, items with line totals and where each
 *    price came from, subtotal
 *  - Total row with how many items it covers, and savings vs. the best
 *    single-store trip only when that trip covers the same items
 *  - "Unassigned" section for items without an eligible price
 */

import React, { useRef } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  PanResponder,
  Animated,
  Dimensions,
} from 'react-native';
import { useActiveTheme } from '../state/useThemeStore';
import type { TripPlan } from '../pricing/trip-plan';
import { navigateToStore } from '../utils/storeNavigation';
import { StoreLogo } from '../pricing/store-branding';

interface TripPlanSheetProps {
  visible: boolean;
  plan: TripPlan | null;
  onClose: () => void;
}

import { themeColors } from './groceryTheme';

export default function TripPlanSheet({
  visible,
  plan,
  onClose,
}: TripPlanSheetProps) {
  const activeTheme = useActiveTheme();
  const theme = themeColors[activeTheme];

  const { height: SCREEN_H } = Dimensions.get('window');
  const COLLAPSED = SCREEN_H * 0.4;
  const EXPANDED  = SCREEN_H * 0.95;
  const sheetHeight = useRef(new Animated.Value(COLLAPSED)).current;
  const committedHeight = useRef(COLLAPSED);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 5,
      onPanResponderMove: (_, g) => {
        const newH = committedHeight.current - g.dy;
        const clamped = Math.max(COLLAPSED, Math.min(EXPANDED, newH));
        sheetHeight.setValue(clamped);
      },
      onPanResponderRelease: (_, g) => {
        const target = (committedHeight.current - g.dy) > (COLLAPSED + (EXPANDED - COLLAPSED) * 0.35)
          ? EXPANDED : COLLAPSED;
        committedHeight.current = target;
        Animated.spring(sheetHeight, {
          toValue: target,
          useNativeDriver: false,
          tension: 60, friction: 11,
        }).start();
      },
    }),
  ).current;

  if (!plan) return null;
  const totalItems =
    plan.stops.reduce((n, stop) => n + stop.items.length, 0) + plan.unassigned.length;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={[styles.overlay, { backgroundColor: theme.overlay }]}>
        <Animated.View style={[styles.sheet, { backgroundColor: theme.cardBg, height: sheetHeight }]}>
          {/* Drag handle */}
          <View style={styles.handleContainer} {...panResponder.panHandlers}>
            <View style={[styles.handleBar, { backgroundColor: theme.secondaryText }]} />
          </View>
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            <View style={styles.headerLeft}>
              <Text style={[styles.headerTitle, { color: theme.text }]}>
                🗺️ Trip Plan
              </Text>
              <Text style={[styles.headerSubtitle, { color: theme.secondaryText }]}>
                {plan.numStops} {plan.numStops === 1 ? 'stop' : 'stops'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Text style={[styles.closeText, { color: theme.secondaryText }]}>
                ✕
              </Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Stops */}
            {plan.stops.map((stop, idx) => (
              <View
                key={stop.storeId}
                style={[
                  styles.stopCard,
                  {
                    backgroundColor: theme.stopBg,
                    borderColor: theme.border,
                  },
                ]}
              >
                <View style={styles.stopHeader}>
                  <Text style={[styles.stopLabel, { color: theme.primary }]}>
                    Stop {idx + 1}
                  </Text>
                  <TouchableOpacity onPress={() => navigateToStore(stop.storeName)} style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                    <StoreLogo storeId={stop.storeId} size={24} />
                    <Text style={[styles.stopStore, { color: theme.primary, marginLeft: 6 }]}>
                      {stop.storeName}
                    </Text>
                    <Text style={{ fontSize: 14, marginLeft: 4, color: theme.primary }}>📍</Text>
                  </TouchableOpacity>
                </View>

                {stop.items.map((item, itemIdx) => (
                  <View
                    key={item.itemId}
                    style={[
                      styles.itemRow,
                      itemIdx < stop.items.length - 1 && {
                        borderBottomColor: theme.divider,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                      },
                    ]}
                  >
                    <View style={styles.itemCell}>
                      <Text style={[styles.itemName, { color: theme.text }]} numberOfLines={1}>
                        {item.itemName}
                        {item.quantity > 1 || item.unit ? ` ×${item.quantity}${item.unit ? ` ${item.unit}` : ''}` : ''}
                      </Text>
                      {(item.evidence || item.quantityAssumed) && (
                        <Text style={[styles.itemEvidence, { color: theme.secondaryText }]} numberOfLines={1}>
                          {[item.evidence, item.quantityAssumed ? 'qty assumed: 1 pkg' : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      )}
                    </View>
                    <Text style={[styles.itemPrice, { color: theme.text }]}>
                      ${item.lineTotal.toFixed(2)}
                    </Text>
                  </View>
                ))}

                <View
                  style={[
                    styles.subtotalRow,
                    { borderTopColor: theme.divider, backgroundColor: theme.subtotalBg },
                  ]}
                >
                  <Text style={[styles.subtotalLabel, { color: theme.secondaryText }]}>
                    Subtotal
                  </Text>
                  <Text style={[styles.subtotalValue, { color: theme.text }]}>
                    ${stop.subtotal.toFixed(2)}
                  </Text>
                </View>
              </View>
            ))}

            {/* Unassigned */}
            {plan.unassigned.length > 0 && (
              <View
                style={[
                  styles.unassignedCard,
                  {
                    backgroundColor: theme.unassignedBg,
                    borderColor: theme.unassignedBorder,
                  },
                ]}
              >
                <Text style={[styles.unassignedTitle, { color: theme.unassignedText }]}>
                  ⚠️ Not in this total — no eligible price
                </Text>
                {plan.unassigned.map((item) => (
                  <Text
                    key={item.itemId}
                    style={[styles.unassignedItem, { color: theme.unassignedText }]}
                  >
                    • {item.itemName}
                    {item.quantity > 1 ? ` ×${item.quantity}` : ''}
                  </Text>
                ))}
              </View>
            )}

            {/* Totals */}
            <View style={[styles.totalCard, { borderColor: theme.border }]}>
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { color: theme.secondaryText }]}>
                  {plan.unassigned.length > 0
                    ? `Estimated Total (${totalItems - plan.unassigned.length} of ${totalItems} items)`
                    : 'Estimated Total'}
                </Text>
                <Text style={[styles.totalValue, { color: theme.text }]}>
                  ${plan.totalCost.toFixed(2)}
                </Text>
              </View>
              {!plan.savingsComparable && plan.numStops > 1 && (
                <Text style={[styles.savingsLabel, { color: theme.secondaryText, marginTop: 6 }]}>
                  No single store carries the same items, so there's no 1-stop price to compare.
                </Text>
              )}
              {plan.savingsComparable && plan.savings > 0 && (
                <View
                  style={[styles.savingsRow, { backgroundColor: theme.savingsBg }]}
                >
                  <Text style={[styles.savingsLabel, { color: theme.savingsText }]}>
                    💰 You save
                  </Text>
                  <Text style={[styles.savingsValue, { color: theme.savingsText }]}>
                    ${plan.savings.toFixed(2)}
                  </Text>
                </View>
              )}
            </View>
          </ScrollView>

          {/* Footer */}
          <TouchableOpacity
            style={[styles.doneBtn, { backgroundColor: theme.primary }]}
            onPress={onClose}
            activeOpacity={0.8}
          >
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerLeft: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  headerSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  closeBtn: {
    padding: 8,
  },
  closeText: {
    fontSize: 18,
    fontWeight: '600',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: 16,
    paddingBottom: 8,
  },
  stopCard: {
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    overflow: 'hidden',
  },
  stopHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 8,
  },
  stopLabel: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  stopStore: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  itemCell: {
    flex: 1,
    marginRight: 12,
  },
  itemName: {
    fontSize: 13,
  },
  itemEvidence: {
    fontSize: 11,
    marginTop: 1,
  },
  itemPrice: {
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  subtotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  subtotalLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  subtotalValue: {
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  unassignedCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  unassignedTitle: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  unassignedItem: {
    fontSize: 12,
    lineHeight: 18,
  },
  totalCard: {
    borderTopWidth: 1,
    paddingTop: 12,
    marginTop: 4,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  totalLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  totalValue: {
    fontSize: 20,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  savingsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  savingsLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  savingsValue: {
    fontSize: 16,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  doneBtn: {
    marginHorizontal: 16,
    marginBottom: 24,
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  doneText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  handleContainer: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  handleBar: {
    width: 40,
    height: 5,
    borderRadius: 2.5,
    opacity: 0.35,
  },
});
