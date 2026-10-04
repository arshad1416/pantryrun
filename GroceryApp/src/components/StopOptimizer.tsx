/**
 * StopOptimizer — collapsible route comparison UI.
 *
 * Renders the proposals of one BasketPlan (computed by the list screen, so
 * the cards, the list sections and the trip sheet share the same numbers).
 * Every card states its coverage; savings are shown only between routes that
 * buy the same items, merchandise-only, with sample-data caveats.
 */

import React, { useState, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import type { BasketPlan, RouteProposal } from '../pricing/basket-planner';
import { MAX_STOPS_LIMIT } from '../pricing/basket-planner';
import { addDays, localDate, type ShoppingWindow } from '../pricing/offer-evidence';
import { coverageLabel, evidenceLabel, extraStopNote, money, savingsStatement, windowLabel } from '../pricing/plan-display';
import { useActiveTheme } from '../state/useThemeStore';
import MaxStopsStepper from './MaxStopsStepper';
import TripPlanSheet from './TripPlanSheet';
import { themeColors } from './groceryTheme';

interface StopOptimizerProps {
  plan: BasketPlan;
  window: ShoppingWindow;
  maxStops: number;
  onChangeMaxStops: (n: number) => void;
  onChangeWindow: (w: ShoppingWindow | null) => void;
  memberships: string[];
  onToggleMembership: (name: string) => void;
  selectedRouteNumStops?: number | null;
  onSelectRouteNumStops?: (numStops: number | null) => void;
}

const MEMBERSHIP_RE = /^requires (.+) membership \(not enabled\)$/;

const WINDOW_CHOICES: { label: string; offset: number; days: number }[] = [
  { label: 'Today', offset: 0, days: 1 },
  { label: 'Tomorrow', offset: 1, days: 1 },
  { label: 'Next 7 days', offset: 0, days: 7 },
];

export default function StopOptimizer({
  plan,
  window,
  maxStops,
  onChangeMaxStops,
  onChangeWindow,
  memberships,
  onToggleMembership,
  selectedRouteNumStops = null,
  onSelectRouteNumStops,
}: StopOptimizerProps) {
  const [expanded, setExpanded] = useState(false);
  const [sheetRoute, setSheetRoute] = useState<RouteProposal | null>(null);
  // Optional: what one more stop costs you (time, fuel). Only used to say
  // whether an extra stop pays for itself — never subtracted from savings.
  const [stopCostInput, setStopCostInput] = useState('');
  const stopCost = stopCostInput.trim() ? parseFloat(stopCostInput.replace(',', '.')) : undefined;
  const extraStopCost = stopCost != null && Number.isFinite(stopCost) && stopCost >= 0 ? stopCost : undefined;
  const activeTheme = useActiveTheme();
  const theme = themeColors[activeTheme];

  const { proposals } = plan;
  const best = proposals[proposals.length - 1];
  const headerBadge = best && best.complete && best.evidence.demo === 0 && (best.savingsVsOneStop ?? 0) > 0
    ? `Save ${money(best.savingsVsOneStop!)} before tax & travel`
    : null;

  // Memberships that would unlock an excluded offer, plus any already enabled.
  const membershipChoices = useMemo(() => {
    const names = new Set(memberships);
    for (const la of plan.lines) {
      for (const c of la.candidates) {
        for (const r of c.reasons) {
          const m = r.match(MEMBERSHIP_RE);
          if (m) names.add(m[1]!);
        }
      }
    }
    return [...names].sort();
  }, [plan, memberships]);

  const today = localDate(Date.now());

  return (
    <View style={[styles.container, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded((prev) => !prev)}
        activeOpacity={0.7}
      >
        <View style={styles.headerLeft}>
          <Text style={[styles.headerTitle, { color: theme.text }]}>🗺️ Smart Route Optimizer</Text>
          {headerBadge && !expanded && (
            <View style={[styles.savingBadgeHeader, { backgroundColor: theme.savingsBg }]}>
              <Text style={[styles.savingBadgeTextHeader, { color: theme.savingsText }]}>{headerBadge}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.chevron, { color: theme.secondaryText }]}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={[styles.body, { borderTopColor: theme.border }]}>
          {/* Shopping window — offers are judged against these days */}
          <View style={styles.choiceRow}>
            <Text style={[styles.planLabel, { color: theme.secondaryText }]}>Shopping:</Text>
            {WINDOW_CHOICES.map((c) => {
              const start = addDays(today, c.offset);
              const w = { start, end: addDays(start, c.days - 1) };
              const active = w.start === window.start && w.end === window.end;
              return (
                <TouchableOpacity
                  key={c.label}
                  style={[styles.chip, { borderColor: active ? theme.primary : theme.border, backgroundColor: active ? theme.activeBg : theme.inactiveBg }]}
                  onPress={() => onChangeWindow(c.offset === 0 && c.days === 1 ? null : w)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.chipText, { color: active ? theme.activeText : theme.text }]}>{c.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={[styles.note, { color: theme.secondaryText }]}>Prices checked for {windowLabel(window)}</Text>

          {membershipChoices.length > 0 && (
            <View style={styles.choiceRow}>
              {membershipChoices.map((m) => {
                const on = memberships.includes(m);
                return (
                  <TouchableOpacity
                    key={m}
                    style={[styles.chip, { borderColor: on ? theme.primary : theme.border, backgroundColor: on ? theme.activeBg : theme.inactiveBg }]}
                    onPress={() => onToggleMembership(m)}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: on }}
                  >
                    <Text style={[styles.chipText, { color: on ? theme.activeText : theme.text }]}>
                      {on ? '✓ ' : ''}I have a {m} membership
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {proposals.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
              {proposals.map((prop, i) => {
                const n = prop.stores.length;
                const isSelected = selectedRouteNumStops === n;
                const saving = savingsStatement(prop, proposals[i - 1]);
                const worthIt = extraStopNote(prop, extraStopCost);
                return (
                  <TouchableOpacity
                    key={n}
                    style={[
                      styles.card,
                      {
                        backgroundColor: theme.cardBg,
                        borderColor: isSelected ? theme.primary : prop.complete ? theme.border : theme.unassignedBorder,
                        borderWidth: isSelected ? 2 : 1,
                      },
                    ]}
                    onPress={() => onSelectRouteNumStops?.(isSelected ? null : n)}
                    onLongPress={() => setSheetRoute(prop)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.cardTitle, { color: theme.text }]}>
                      {n} {n === 1 ? 'STOP' : 'STOPS'}
                    </Text>
                    <Text style={[styles.cardTotal, { color: theme.text }]}>
                      <Text style={styles.bold}>{money(prop.merchandiseTotal)}</Text> merchandise
                    </Text>
                    <Text style={[styles.coverage, { color: prop.complete ? theme.secondaryText : theme.unassignedText }]}>
                      {prop.complete ? '✓ ' : '⚠️ '}
                      {coverageLabel(prop.coveredItemIds.length, plan.eligibleItemIds.length)}
                      {prop.complete ? '' : ' — incomplete'}
                    </Text>
                    <Text style={[styles.cardStores, { color: theme.secondaryText }]} numberOfLines={2}>
                      {prop.stores.map((s) => s.storeName).join(' + ')}
                    </Text>
                    <Text style={[styles.evidence, { color: theme.secondaryText }]} numberOfLines={1}>
                      {evidenceLabel(prop.evidence)}
                    </Text>
                    {saving && (
                      <View style={[styles.savingsBadge, { backgroundColor: prop.complete ? theme.savingsBg : theme.unassignedBg }]}>
                        <Text style={[styles.savingsText, { color: prop.complete ? theme.savingsText : theme.unassignedText }]}>{saving}</Text>
                      </View>
                    )}
                    {worthIt && (
                      <Text style={[styles.evidence, { color: theme.secondaryText }]}>{worthIt}</Text>
                    )}
                    <TouchableOpacity onPress={() => setSheetRoute(prop)} accessibilityRole="button">
                      <Text style={[styles.detailsLink, { color: theme.primary }]}>Details ›</Text>
                    </TouchableOpacity>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : (
            <Text style={[styles.note, { color: theme.secondaryText, paddingHorizontal: 14 }]}>
              No store has a usable price for any item yet.
            </Text>
          )}

          {plan.caveats.map((c) => (
            <Text key={c} style={[styles.note, { color: theme.secondaryText, paddingHorizontal: 14 }]}>• {c}</Text>
          ))}

          <View style={styles.choiceRow}>
            <Text style={[styles.planLabel, { color: theme.secondaryText }]}>Cost of one extra stop (optional): $</Text>
            <TextInput
              style={[styles.costInput, { color: theme.text, borderColor: theme.border }]}
              value={stopCostInput}
              onChangeText={setStopCostInput}
              keyboardType="decimal-pad"
              placeholder="—"
              placeholderTextColor={theme.secondaryText}
              accessibilityLabel="Cost of one extra stop"
            />
          </View>

          <View style={styles.planSection}>
            <Text style={[styles.planLabel, { color: theme.secondaryText }]}>Max stops:</Text>
            <MaxStopsStepper value={maxStops} max={MAX_STOPS_LIMIT} onChange={onChangeMaxStops} />
            {best && (
              <TouchableOpacity
                style={[styles.planButton, { backgroundColor: theme.primary }]}
                onPress={() => setSheetRoute(best)}
                activeOpacity={0.8}
              >
                <Text style={styles.planButtonText}>Plan My Trip</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
      <TripPlanSheet
        visible={sheetRoute !== null}
        route={sheetRoute}
        plan={plan}
        window={window}
        onClose={() => setSheetRoute(null)}
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
    flexShrink: 1,
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
    flexShrink: 1,
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
  choiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    marginBottom: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  note: {
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 4,
    paddingHorizontal: 14,
  },
  costInput: {
    minWidth: 56,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 12,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
  card: {
    width: 190,
    padding: 12,
    marginRight: 10,
    borderRadius: 12,
    justifyContent: 'space-between',
    minHeight: 150,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  cardTotal: {
    fontSize: 13,
    marginBottom: 2,
  },
  coverage: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  cardStores: {
    fontSize: 11,
    lineHeight: 14,
    marginBottom: 2,
  },
  evidence: {
    fontSize: 10,
    marginBottom: 6,
  },
  bold: {
    fontWeight: '700',
  },
  savingsBadge: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 6,
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  savingsText: {
    fontSize: 10,
    fontWeight: '700',
  },
  detailsLink: {
    fontSize: 12,
    fontWeight: '700',
  },
  planSection: {
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    paddingTop: 8,
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
