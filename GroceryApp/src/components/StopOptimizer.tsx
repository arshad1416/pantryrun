/**
 * StopOptimizer — collapsible multi-stop route optimization UI.
 *
 * Renders route proposals computed by GroceryListScreen from the same
 * basket analysis as the store cards, plus the trip-plan controls:
 * stop cap, shopping day, confirmed memberships and whether "sale only"
 * holds are needed now. The trip sheet's plan is derived live from the
 * current analysis — never a snapshot — so an edit, refresh or clock tick
 * while it's open can't leave a stale recommendation on screen.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { solvePlan, type BasketAnalysis, type BasketItem } from '../pricing/basket';
import type { StopProposal } from '../pricing/stop-optimizer';
import { toTripPlan } from '../pricing/trip-plan';
import { useActiveTheme } from '../state/useThemeStore';
import MaxStopsStepper from './MaxStopsStepper';
import TripPlanSheet from './TripPlanSheet';
import { themeColors } from './groceryTheme';

export type ShoppingDay = 'today' | 'tomorrow' | 'week';

export interface PlanOptions {
  maxStops: number;
  shoppingDay: ShoppingDay;
  /** Confirmed memberships, e.g. ['costco'] */
  memberships: string[];
  /** "Sale only" holds are needed now — fulfilment is incomplete without them */
  requireHeld: boolean;
}

interface StopOptimizerProps {
  /** Basket lines the analysis was built from */
  items: BasketItem[];
  analysis: BasketAnalysis;
  proposals: StopProposal[];
  storeNameMap: Record<string, string>;
  options: PlanOptions;
  onChangeOptions: (options: PlanOptions) => void;
  /** Clock the analysis was evaluated at */
  now: number;
  selectedRouteNumStops?: number | null;
  onSelectRouteNumStops?: (numStops: number | null) => void;
}

const DAY_LABELS: Record<ShoppingDay, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'Next 7 days',
};

export default function StopOptimizer({
  items,
  analysis,
  proposals,
  storeNameMap,
  options,
  onChangeOptions,
  now,
  selectedRouteNumStops = null,
  onSelectRouteNumStops,
}: StopOptimizerProps) {
  const [expanded, setExpanded] = useState(false);
  const [showTripSheet, setShowTripSheet] = useState(false);
  const activeTheme = useActiveTheme();
  const theme = themeColors[activeTheme];
  const setOption = useCallback(
    <K extends keyof PlanOptions>(key: K, value: PlanOptions[K]) => onChangeOptions({ ...options, [key]: value }),
    [options, onChangeOptions],
  );

  // Live: recomputed whenever the analysis (prices, list, rules, clock) or options change.
  const tripPlan = useMemo(() => {
    if (!showTripSheet) return null;
    const ctx = { requireHeldItems: options.requireHeld };
    return toTripPlan(
      items,
      solvePlan(analysis, options.maxStops, ctx),
      solvePlan(analysis, 1, ctx),
      storeNameMap,
      now,
    );
  }, [showTripSheet, items, analysis, options.maxStops, options.requireHeld, storeNameMap, now]);

  // "Best value" goes to the cheapest route that leaves nothing unsupplied —
  // never to a route that's cheap because it leaves items out.
  const bestValueNumStops = useMemo(() => {
    let best: StopProposal | null = null;
    for (const p of proposals) {
      if (p.plan.fulfillment === 'incomplete') continue;
      if (!best || p.totalCost < best.totalCost) best = p;
    }
    return proposals.length > 1 ? best?.numStops ?? null : null;
  }, [proposals]);

  // Largest honest saving: only proposals compared against the same lines
  const maxSavings = Math.max(0, ...proposals.map((p) => p.savingsVsOneStop ?? 0));
  const best = proposals[proposals.length - 1];
  const noCompletePlan = proposals.length > 0 && proposals.every((p) => p.plan.fulfillment === 'incomplete');
  const costcoConfirmed = options.memberships.includes('costco');

  return (
    <View style={[styles.container, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded((prev) => !prev)}
        activeOpacity={0.7}
      >
        <View style={styles.headerLeft}>
          <Text style={[styles.headerTitle, { color: theme.text }]}>🗺️ Smart Route Optimizer</Text>
          {maxSavings > 0 && !expanded && !noCompletePlan && (
            <View style={[styles.savingBadgeHeader, { backgroundColor: theme.savingsBg }]}>
              <Text style={[styles.savingBadgeTextHeader, { color: theme.savingsText }]}>
                Save up to ${maxSavings.toFixed(2)} vs 1 stop
              </Text>
            </View>
          )}
        </View>
        <Text style={[styles.chevron, { color: theme.secondaryText }]}>
          {expanded ? '▲' : '▼'}
        </Text>
      </TouchableOpacity>

      {expanded && (
        <View style={[styles.body, { borderTopColor: theme.border }]}>
          {noCompletePlan && best && (
            <Text style={[styles.notice, { color: theme.unassignedText }]}>
              No complete plan with these stores — {best.missingItemIds.length} item
              {best.missingItemIds.length === 1 ? '' : 's'} can't be priced
              {options.requireHeld && best.heldItemIds.length > 0
                ? ` and ${best.heldItemIds.length} held for a sale`
                : ''}
              . Totals below are partial and not a cheapest-basket claim.
            </Text>
          )}
          {proposals.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.scrollContent}
            >
              {proposals.map((prop) => {
                const isSelected = selectedRouteNumStops === prop.numStops;
                const isBestValue = prop.numStops === bestValueNumStops;
                const isIncomplete = prop.plan.fulfillment === 'incomplete';
                const missing = prop.missingItemIds.length;
                const held = prop.heldItemIds.length;

                return (
                  <TouchableOpacity
                    key={prop.numStops}
                    style={[
                      styles.card,
                      {
                        backgroundColor: theme.cardBg,
                        borderColor: isSelected
                          ? theme.primary
                          : isBestValue
                          ? theme.bestValueBorder
                          : theme.border,
                        borderWidth: isSelected || isBestValue ? 2 : 1,
                      },
                    ]}
                    onPress={() => onSelectRouteNumStops?.(isSelected ? null : prop.numStops)}
                    activeOpacity={0.8}
                  >
                    {isBestValue && (
                      <View style={[styles.bestValueBadge, { backgroundColor: theme.bestValueBg }]}>
                        <Text style={[styles.bestValueText, { color: theme.bestValueText }]}>
                          {prop.plan.claim === 'verified' ? 'BEST VALUE' : 'LOWEST ESTIMATE'}
                        </Text>
                      </View>
                    )}
                    <Text style={[styles.cardTitle, { color: theme.text }]}>
                      {prop.numStops} {prop.numStops === 1 ? 'STOP' : 'STOPS'}
                    </Text>
                    <Text style={[styles.cardTotal, { color: theme.text }]}>
                      {isIncomplete ? 'Partial: ' : prop.plan.claim === 'verified' ? 'Total: ' : 'Est. Total: '}
                      <Text style={[styles.bold, { color: theme.text }]}>
                        ${prop.totalCost.toFixed(2)}
                      </Text>
                    </Text>
                    <Text style={[styles.cardStores, { color: theme.secondaryText }]} numberOfLines={2}>
                      {prop.stores.map((s) => s.storeName).join(' + ')}
                    </Text>
                    <Text style={[styles.cardStores, { color: missing > 0 ? theme.unassignedText : theme.secondaryText }]}>
                      {`${prop.coveredCount} of ${prop.totalCount} items priced`}
                      {held > 0 ? ` · ${held} held (sale only)` : ''}
                      {missing > 0 ? ` · ${missing} not priced` : ''}
                    </Text>
                    {prop.savingsVsOneStop === null && prop.numStops > 1 && (
                      <Text style={[styles.cardStores, { color: theme.secondaryText }]}>
                        Savings unavailable — 1 stop prices different items
                      </Text>
                    )}
                    {prop.savingsVsOneStop !== null && prop.savingsVsOneStop > 0 && (
                      <View style={[styles.savingsBadge, { backgroundColor: theme.savingsBg }]}>
                        <Text style={[styles.savingsText, { color: theme.savingsText }]}>
                          * Saves ${prop.savingsVsOneStop.toFixed(2)} vs 1 stop
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
          {/* Plan controls + Plan My Trip button */}
          <View style={styles.planSection}>
            <Text style={[styles.planLabel, { color: theme.secondaryText }]}>
              Max stops:
            </Text>
            <MaxStopsStepper value={options.maxStops} onChange={(n) => setOption('maxStops', n)} />
            <Text style={[styles.planLabel, { color: theme.secondaryText }]}>
              Shopping:
            </Text>
            <View style={styles.chipRow}>
              {(Object.keys(DAY_LABELS) as ShoppingDay[]).map((day) => {
                const active = options.shoppingDay === day;
                return (
                  <TouchableOpacity
                    key={day}
                    style={[styles.chip, { borderColor: active ? theme.primary : theme.border, backgroundColor: active ? theme.primary : 'transparent' }]}
                    onPress={() => setOption('shoppingDay', day)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.chipText, { color: active ? '#FFFFFF' : theme.text }]}>{DAY_LABELS[day]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={styles.chipRow}>
              <TouchableOpacity
                style={[styles.chip, { borderColor: costcoConfirmed ? theme.primary : theme.border }]}
                onPress={() => setOption(
                  'memberships',
                  costcoConfirmed ? options.memberships.filter((m) => m !== 'costco') : [...options.memberships, 'costco'],
                )}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: costcoConfirmed }}
              >
                <Text style={[styles.chipText, { color: theme.text }]}>
                  {costcoConfirmed ? '☑' : '☐'} I have a Costco membership
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.chip, { borderColor: options.requireHeld ? theme.primary : theme.border }]}
                onPress={() => setOption('requireHeld', !options.requireHeld)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: options.requireHeld }}
              >
                <Text style={[styles.chipText, { color: theme.text }]}>
                  {options.requireHeld ? '☑' : '☐'} Need "sale only" items now
                </Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[styles.planButton, { backgroundColor: theme.primary }]}
              onPress={() => setShowTripSheet(true)}
              activeOpacity={0.8}
            >
              <Text style={styles.planButtonText}>Plan My Trip</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      {/* Trip Plan Sheet */}
      <TripPlanSheet
        visible={showTripSheet}
        plan={tripPlan}
        onClose={() => setShowTripSheet(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  savingBadgeHeader: {
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  savingBadgeTextHeader: {
    fontSize: 10,
    fontWeight: '700',
  },
  chevron: {
    fontSize: 10,
  },
  body: {
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingTop: 8, // space for BEST VALUE badge overlay
  },
  card: {
    width: 170,
    padding: 12,
    marginRight: 10,
    borderRadius: 12,
    position: 'relative',
    justifyContent: 'space-between',
    minHeight: 115,
  },
  bestValueBadge: {
    position: 'absolute',
    top: -10,
    right: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#10B981',
  },
  bestValueText: {
    fontSize: 8,
    fontWeight: '900',
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  cardTotal: {
    fontSize: 13,
    marginBottom: 4,
  },
  cardStores: {
    fontSize: 11,
    lineHeight: 14,
    marginBottom: 6,
    flex: 1,
  },
  bold: {
    fontWeight: '700',
  },
  savingsBadge: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  savingsText: {
    fontSize: 10,
    fontWeight: '700',
  },
  planSection: {
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    paddingTop: 4,
    gap: 10,
  },
  notice: {
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  planLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  planButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 10,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  planButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});
