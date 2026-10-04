/**
 * TripPlanSheet — bottom sheet for one route of a BasketPlan.
 *
 * Displays:
 *  - Per-stop sections: each line with what to buy (packs × size or weight),
 *    its line total, source, and any date/stock restriction; stop subtotal
 *  - Lines this route cannot buy, and lines held out of the comparison, each
 *    with its reason — nothing is silently priced at $0
 *  - Merchandise total, labelled as excluding tax, travel, delivery fees and
 *    memberships; savings only when the compared routes cover the same lines
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
import type { BasketPlan, RouteProposal } from '../pricing/basket-planner';
import type { ShoppingWindow } from '../pricing/offer-evidence';
import { coverageLabel, money, provenanceLabel, savingsStatement, windowLabel } from '../pricing/plan-display';
import { navigateToStore } from '../utils/storeNavigation';
import { StoreLogo } from '../pricing/store-branding';

interface TripPlanSheetProps {
  visible: boolean;
  route: RouteProposal | null;
  plan: BasketPlan;
  window: ShoppingWindow;
  onClose: () => void;
}

import { themeColors } from './groceryTheme';

export default function TripPlanSheet({
  visible,
  route,
  plan,
  window,
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

  if (!route) return null;

  const idx = plan.proposals.indexOf(route);
  const saving = savingsStatement(route, idx > 0 ? plan.proposals[idx - 1] : undefined);
  const nameOf = (id: string) => plan.lines.find((l) => l.line.itemId === id)?.line.displayName ?? id;
  const numStops = route.stores.length;

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
                {numStops} {numStops === 1 ? 'stop' : 'stops'} · {coverageLabel(route.coveredItemIds.length, plan.eligibleItemIds.length)} · {windowLabel(window)}
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
            {route.stores.map((stop, stopIdx) => {
              const lines = route.assignments.filter((a) => a.candidate.storeId === stop.storeId);
              return (
                <View
                  key={stop.storeId}
                  style={[styles.stopCard, { backgroundColor: theme.stopBg, borderColor: theme.border }]}
                >
                  <View style={styles.stopHeader}>
                    <Text style={[styles.stopLabel, { color: theme.primary }]}>
                      Stop {stopIdx + 1}
                    </Text>
                    <TouchableOpacity onPress={() => navigateToStore(stop.storeName)} style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                      <StoreLogo storeId={stop.storeId} size={24} />
                      <Text style={[styles.stopStore, { color: theme.primary, marginLeft: 6 }]}>
                        {stop.storeName}
                      </Text>
                      <Text style={{ fontSize: 14, marginLeft: 4, color: theme.primary }}>📍</Text>
                    </TouchableOpacity>
                  </View>

                  {lines.map((a, i) => {
                    const c = a.candidate;
                    const notes = [
                      c.purchaseDescription,
                      provenanceLabel(c.provenance),
                      c.verdict === 'substitute' ? `substitute: ${c.reasons.join('; ')}` : '',
                      c.restriction ?? '',
                    ].filter(Boolean);
                    return (
                      <View
                        key={a.itemId}
                        style={[
                          styles.itemRow,
                          i < lines.length - 1 && { borderBottomColor: theme.divider, borderBottomWidth: StyleSheet.hairlineWidth },
                        ]}
                      >
                        <View style={styles.itemText}>
                          <Text style={[styles.itemName, { color: theme.text }]} numberOfLines={1}>
                            {a.name}
                          </Text>
                          <Text
                            style={[styles.itemNote, { color: c.restriction || c.verdict === 'substitute' || c.provenance === 'demo' ? theme.unassignedText : theme.secondaryText }]}
                            numberOfLines={2}
                          >
                            {notes.join(' · ')}
                          </Text>
                        </View>
                        <Text style={[styles.itemPrice, { color: theme.text }]}>
                          {money(c.lineTotal ?? 0)}
                        </Text>
                      </View>
                    );
                  })}

                  <View style={[styles.subtotalRow, { borderTopColor: theme.divider, backgroundColor: theme.subtotalBg }]}>
                    <Text style={[styles.subtotalLabel, { color: theme.secondaryText }]}>Subtotal</Text>
                    <Text style={[styles.subtotalValue, { color: theme.text }]}>{money(stop.subtotal)}</Text>
                  </View>
                </View>
              );
            })}

            {/* Eligible lines this route can't buy */}
            {route.missingItemIds.length > 0 && (
              <View style={[styles.unassignedCard, { backgroundColor: theme.unassignedBg, borderColor: theme.unassignedBorder }]}>
                <Text style={[styles.unassignedTitle, { color: theme.unassignedText }]}>
                  ⚠️ Not available on this route — total is incomplete
                </Text>
                {route.missingItemIds.map((id) => (
                  <Text key={id} style={[styles.unassignedItem, { color: theme.unassignedText }]}>
                    • {nameOf(id)}
                  </Text>
                ))}
              </View>
            )}

            {/* Lines held out of the comparison */}
            {plan.held.length > 0 && (
              <View style={[styles.unassignedCard, { backgroundColor: theme.unassignedBg, borderColor: theme.unassignedBorder }]}>
                <Text style={[styles.unassignedTitle, { color: theme.unassignedText }]}>
                  Held out of the comparison
                </Text>
                {plan.held.map((h) => (
                  <Text key={h.itemId} style={[styles.unassignedItem, { color: theme.unassignedText }]}>
                    • {h.name}: {h.reasons.join('; ')}
                  </Text>
                ))}
              </View>
            )}

            {/* Totals */}
            <View style={[styles.totalCard, { borderColor: theme.border }]}>
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { color: theme.secondaryText }]}>
                  Merchandise total
                </Text>
                <Text style={[styles.totalValue, { color: theme.text }]}>
                  {money(route.merchandiseTotal)}
                </Text>
              </View>
              {saving && (
                <View style={[styles.savingsRow, { backgroundColor: route.complete ? theme.savingsBg : theme.unassignedBg }]}>
                  <Text style={[styles.savingsLabel, { color: route.complete ? theme.savingsText : theme.unassignedText }]}>
                    {saving}
                  </Text>
                </View>
              )}
              {plan.caveats.map((c) => (
                <Text key={c} style={[styles.caveat, { color: theme.secondaryText }]}>• {c}</Text>
              ))}
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
  itemText: {
    flex: 1,
    marginRight: 12,
  },
  itemName: {
    fontSize: 13,
  },
  itemNote: {
    fontSize: 11,
    marginTop: 1,
  },
  caveat: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 4,
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
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
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
