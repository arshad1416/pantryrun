/**
 * StopOptimizer — collapsible multi-stop route optimization UI.
 *
 * Displays proposals below the StoreTotalBar when available.
 * Always renders MaxStopsStepper and Plan My Trip button so the
 * user can plan a trip even with a single-store proposal.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import type { PriceResult } from '../pricing/types';
import { computeStopProposals } from '../pricing/stop-optimizer';
import { computeTripPlan } from '../pricing/trip-plan';
import { buildCacheKey, getCachedPlan, setCachedPlan } from '../pricing/trip-plan-cache';
import { useActiveTheme } from '../state/useThemeStore';
import MaxStopsStepper from './MaxStopsStepper';
import TripPlanSheet from './TripPlanSheet';
import type { TripPlan } from '../pricing/trip-plan';

interface StopOptimizerProps {
  /** Basket items (unchecked) — prices must already be eligibility-filtered */
  items: { id: string; quantity: number; unit?: string; name?: string }[];
  perStorePrices: Record<string, Record<string, PriceResult>>;
  storeNameMap: Record<string, string>;
  selectedRouteNumStops?: number | null;
  onSelectRouteNumStops?: (numStops: number | null) => void;
  /** Full item data (name + unit) for trip plan computation */
  fullItems?: { id: string; name: string; quantity: number; unit: string }[];
}

import { themeColors } from './groceryTheme';

export default function StopOptimizer({
  items,
  perStorePrices,
  storeNameMap,
  selectedRouteNumStops = null,
  onSelectRouteNumStops,
  fullItems,
}: StopOptimizerProps) {
  const [expanded, setExpanded] = useState(false);
  const [maxStops, setMaxStops] = useState(3);
  const [tripPlan, setTripPlan] = useState<TripPlan | null>(null);
  const [showTripSheet, setShowTripSheet] = useState(false);
  const activeTheme = useActiveTheme();
  const theme = themeColors[activeTheme];

  const proposals = useMemo(
    () => computeStopProposals(items, perStorePrices, storeNameMap, maxStops),
    [items, perStorePrices, storeNameMap, maxStops],
  );

  // "Best value" goes to the cheapest route that covers the whole basket —
  // never to a route that's cheap because it leaves items out.
  const bestValueNumStops = useMemo(() => {
    let best: (typeof proposals)[number] | null = null;
    for (const p of proposals) {
      if (p.coveredCount !== p.totalCount) continue;
      if (!best || p.totalCost < best.totalCost) best = p;
    }
    return proposals.length > 1 ? best?.numStops ?? null : null;
  }, [proposals]);

  // Trip plan handler
  const handlePlanTrip = useCallback(() => {
    const itemsToPlan = fullItems ?? items.map((i) => ({ ...i, name: '', unit: '' }));

    // Check cache first — the key includes every price, so a price change
    // can't return a stale plan.
    const cacheKey = buildCacheKey(maxStops, itemsToPlan, perStorePrices);

    let plan = getCachedPlan(cacheKey);
    if (!plan) {
      plan = computeTripPlan(itemsToPlan, perStorePrices, maxStops, undefined, storeNameMap);
      setCachedPlan(cacheKey, plan);
    }

    setTripPlan(plan);
    setShowTripSheet(true);
  }, [fullItems, items, maxStops, perStorePrices, storeNameMap]);

  // Largest honest saving: only proposals compared against the same basket
  const maxSavings = Math.max(0, ...proposals.map((p) => p.savingsVsOneStop ?? 0));

  return (
    <View style={[styles.container, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded((prev) => !prev)}
        activeOpacity={0.7}
      >
        <View style={styles.headerLeft}>
          <Text style={[styles.headerTitle, { color: theme.text }]}>🗺️ Smart Route Optimizer</Text>
          {maxSavings > 0 && !expanded && (
            <View style={[styles.savingBadgeHeader, { backgroundColor: theme.savingsBg }]}>
              <Text style={[styles.savingBadgeTextHeader, { color: theme.savingsText }]}>
                Save up to ${maxSavings.toFixed(2)}!
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
          {proposals.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.scrollContent}
            >
              {proposals.map((prop) => {
                const isSelected = selectedRouteNumStops === prop.numStops;
                const isBestValue = prop.numStops === bestValueNumStops;
                const isPartial = prop.coveredCount < prop.totalCount;

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
                          BEST VALUE
                        </Text>
                      </View>
                    )}
                    <Text style={[styles.cardTitle, { color: theme.text }]}>
                      {prop.numStops} {prop.numStops === 1 ? 'STOP' : 'STOPS'}
                    </Text>
                    <Text style={[styles.cardTotal, { color: theme.text }]}>
                      Est. Total:{' '}
                      <Text style={[styles.bold, { color: theme.text }]}>
                        ${prop.totalCost.toFixed(2)}
                      </Text>
                    </Text>
                    <Text style={[styles.cardStores, { color: theme.secondaryText }]} numberOfLines={2}>
                      {prop.stores.map((s) => s.storeName).join(' + ')}
                    </Text>
                    <Text style={[styles.cardStores, { color: isPartial ? theme.unassignedText : theme.secondaryText }]}>
                      {isPartial
                        ? `${prop.coveredCount} of ${prop.totalCount} items · ${prop.totalCount - prop.coveredCount} not priced`
                        : `All ${prop.totalCount} items`}
                    </Text>
                    {prop.savingsVsOneStop === null && prop.numStops > 1 && (
                      <Text style={[styles.cardStores, { color: theme.secondaryText }]}>
                        Not comparable to 1 stop — different items covered
                      </Text>
                    )}
                    {prop.savingsVsOneStop !== null && prop.savingsVsOneStop > 0 && (
                      <View style={[styles.savingsBadge, { backgroundColor: theme.savingsBg }]}>
                        <Text style={[styles.savingsText, { color: theme.savingsText }]}>
                          * You Save: ${prop.savingsVsOneStop.toFixed(2)}
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
          {/* Max stops stepper + Plan My Trip button */}
          <View style={styles.planSection}>
            <Text style={[styles.planLabel, { color: theme.secondaryText }]}>
              Max stops:
            </Text>
            <MaxStopsStepper value={maxStops} onChange={setMaxStops} />
            <TouchableOpacity
              style={[styles.planButton, { backgroundColor: theme.primary }]}
              onPress={handlePlanTrip}
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
