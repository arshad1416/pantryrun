/**
 * StoreCard — Horizontal scroll card for store selection.
 * Shows store name, the total for the items this store can supply, and how
 * many of the basket's items that total covers. Selected card has green
 * glow/highlight.
 */

import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View, Platform, Image } from 'react-native';
import { useActiveTheme } from '../state/useThemeStore';
import { themeColors } from './groceryTheme';
import { getStoreColor, getStoreInitial, getStoreLogo } from '../pricing/store-branding';

interface StoreCardProps {
  storeName: string;
  storeId: string;
  total: number;
  /** Basket items this store has an eligible price for */
  coveredCount: number;
  /** Basket items in total */
  totalCount: number;
  isSelected: boolean;
  onPress: () => void;
}


export default function StoreCard({
  storeName,
  storeId,
  total,
  coveredCount,
  totalCount,
  isSelected,
  onPress,
}: StoreCardProps) {
  const activeTheme = useActiveTheme();
  const isDark = activeTheme === 'dark';
  const theme = isDark ? themeColors.dark : themeColors.light;
  const storeColor = getStoreColor(storeId);
  const logoSource = getStoreLogo(storeId.toLowerCase());

  return (
    <TouchableOpacity
      style={[
        styles.card,
        isSelected
          ? {
              backgroundColor: theme.bestValueBg,
              borderColor: theme.bestValueBorder,
              shadowColor: theme.primary,
              shadowOpacity: isDark ? 0.15 : 0.08,
            }
          : {
              backgroundColor: theme.cardBg,
              borderColor: theme.border,
              shadowOpacity: 0,
            },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.topRow}>
        {logoSource ? (
          <Image
            source={logoSource}
            style={styles.logoImage}
            resizeMode="contain"
          />
        ) : (
          <View style={[styles.initialBadge, { backgroundColor: storeColor + '20' }]}>
            <Text style={[styles.initialText, { color: storeColor }]}>
              {getStoreInitial(storeName)}
            </Text>
          </View>
        )}
        {isSelected && (
          <View style={[styles.selectedDot, { backgroundColor: theme.primary }]} />
        )}
      </View>
      <Text
        style={[
          styles.storeName,
          { color: theme.text },
          isSelected && { fontWeight: '700' },
        ]}
        numberOfLines={1}
      >
        {storeName}
      </Text>
      <Text style={[styles.total, { color: isSelected ? theme.primary : theme.secondaryText }]}>
        {coveredCount > 0 ? `$${total.toFixed(2)}` : 'No prices'}
      </Text>
      <Text style={[styles.itemCount, { color: theme.secondaryText }]}>
        {coveredCount === totalCount
          ? `${totalCount} item${totalCount !== 1 ? 's' : ''}`
          : `${coveredCount} of ${totalCount} items`}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 130,
    borderRadius: 16,
    padding: 12,
    marginRight: 10,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  initialBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  initialText: {
    fontSize: 14,
    fontWeight: '700',
  },
  logoImage: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  selectedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  storeName: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  total: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 2,
  },
  itemCount: {
    fontSize: 11,
  },
});
