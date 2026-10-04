/**
 * StoreTotalBar — Horizontal scrollable row of store pills with price totals.
 */

import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useActiveTheme } from '../state/useThemeStore';
import { themeColors } from './groceryTheme';
import { StoreLogo } from '../pricing/store-branding';

export interface StoreTotal {
  storeId: string;
  storeName: string;
  /** Cost of the items this store covers */
  total: number;
  coveredCount: number;
  totalCount: number;
}

interface StoreTotalBarProps {
  storeTotals: StoreTotal[];
  selectedStoreId: string | null;
  onSelectStore: (storeId: string | null) => void;
}

export default function StoreTotalBar({ storeTotals, selectedStoreId, onSelectStore }: StoreTotalBarProps) {
  if (storeTotals.length === 0) return null;

  const activeTheme = useActiveTheme();
  const theme = activeTheme === 'dark' ? themeColors.dark : themeColors.light;
  const isDark = activeTheme === 'dark';

  // Totals are sorted coverage-first; only a store carrying the whole basket
  // can be called cheapest — a partial total isn't comparable.
  const first = storeTotals[0];
  const cheapestId = first && first.coveredCount === first.totalCount ? first.storeId : null;

  return (
    <View style={styles.storeTotalBarContainer}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.storeTotalBarScroll}
      >
        <TouchableOpacity
          style={[
            styles.storeTotalPill,
            {
              backgroundColor: selectedStoreId === null ? theme.primary : theme.cardBg,
              borderColor: selectedStoreId === null ? theme.primary : theme.border,
            },
          ]}
          onPress={() => onSelectStore(null)}
        >
          <Text style={[
            styles.storeTotalPillText,
            { color: selectedStoreId === null ? '#fff' : theme.text },
          ]}>All Categories</Text>
        </TouchableOpacity>
        {storeTotals.map((st) => {
          const isSelected = selectedStoreId === st.storeId;
          const isCheapest = st.storeId === cheapestId && selectedStoreId === null;
          return (
            <TouchableOpacity
              key={st.storeId}
              style={[
                styles.storeTotalPill,
                {
                  backgroundColor: isSelected
                    ? theme.primary
                    : isCheapest
                      ? theme.pillCheapestBg
                      : theme.pillUnselectedBg,
                  borderColor: isSelected
                    ? theme.primary
                    : isCheapest
                      ? theme.pillCheapestBorder
                      : theme.pillUnselectedBorder,
                },
              ]}
              onPress={() => onSelectStore(isSelected ? null : st.storeId)}
            >
              <StoreLogo storeId={st.storeId} size={18} />
              <Text style={[
                styles.storeTotalPillText,
                { color: isSelected ? '#fff' : theme.text },
              ]}>
                {st.storeName}
              </Text>
              <View style={[
                styles.storeTotalBadge,
                {
                  backgroundColor: isSelected
                    ? 'rgba(255,255,255,0.3)'
                    : isCheapest
                      ? '#10B981'
                      : isDark
                        ? '#334155'
                        : '#f0f0f0',
                },
              ]}>
                <Text style={[
                  styles.storeTotalBadgeText,
                  { color: isSelected || isCheapest ? '#fff' : theme.text },
                ]}>
                  ${st.total.toFixed(2)}
                  {st.coveredCount < st.totalCount ? ` · ${st.coveredCount}/${st.totalCount}` : ''}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  storeTotalBarContainer: {
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  storeTotalBarScroll: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
  },
  storeTotalPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    gap: 4,
  },
  storeTotalPillText: {
    fontSize: 12,
    color: '#555',
    fontWeight: '600',
  },
  storeTotalBadge: {
    backgroundColor: '#f0f0f0',
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  storeTotalBadgeText: {
    fontSize: 11,
    color: '#333',
    fontWeight: '700',
  },
});
