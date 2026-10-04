/**
 * ItemRow — Renders a single grocery item with check, emoji, name, quantity stepper, and price.
 * Antigravity redesign: Ionicons, neon green checkbox glow (dark), warm sage (light).
 */

import React, { memo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from 'react-native';
import type { GroceryItem } from '../types';
import type { ItemPriceInfo } from '../pricing/plan-display';
import { emojiForItem } from '../pricing/emoji-map';
import { useActiveTheme } from '../state/useThemeStore';
import { themeColors } from './groceryTheme';
import { Ionicons } from '@expo/vector-icons';
import QuantityStepper from './QuantityStepper';

export interface ItemRowProps {
  item: GroceryItem;
  onToggle: (id: string) => void;
  onPress: (item: GroceryItem) => void;
  onLongPress?: (id: string, name: string) => void;
  onDelete?: (id: string, name: string) => void;
  onMoveUp?: (id: string) => void;
  onMoveDown?: (id: string) => void;
  isFirst: boolean;
  isLast: boolean;
  /** What this line costs in the current view, or why it is held. */
  priceInfo?: ItemPriceInfo | null;
  priceLoading?: boolean;
  onClaim?: (id: string) => void;
  onUnclaim?: (id: string) => void;
  claimerName?: string;
  claimExpired?: boolean;
  onQuantityChange?: (id: string, delta: number) => void;
}

const ItemRow = memo(function ItemRow({
  item,
  onToggle,
  onPress,
  onLongPress,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  priceInfo,
  priceLoading,
  onQuantityChange,
}: ItemRowProps) {
  const isClaimed = !!item.claimedBy && !!item.claimedAt;
  const claimExpired = isClaimed && item.claimedAt
    ? Date.now() - item.claimedAt >= 30 * 60 * 1000
    : false;
  const activeTheme = useActiveTheme();
  const theme = activeTheme === 'dark' ? themeColors.dark : themeColors.light;
  const isDark = activeTheme === 'dark';

  // Scale animation for checkbox
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const strikeAnim = useRef(new Animated.Value(item.isChecked ? 1 : 0)).current;

  const handleCheckToggle = useCallback(() => {
    Animated.sequence([
      Animated.spring(scaleAnim, {
        toValue: 1.2,
        useNativeDriver: true,
        damping: 8,
        stiffness: 200,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        useNativeDriver: true,
        damping: 8,
        stiffness: 200,
      }),
    ]).start();

    const targetValue = item.isChecked ? 0 : 1;
    Animated.timing(strikeAnim, {
      toValue: targetValue,
      duration: 200,
      useNativeDriver: false,
    }).start();

    onToggle(item.id);
  }, [item.isChecked, item.id, onToggle, scaleAnim, strikeAnim]);

  const strikeWidth = strikeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
    extrapolate: 'clamp',
  });

  return (
    <View
      style={[
        styles.itemRow,
        item.isChecked && styles.itemRowChecked,
        {
          backgroundColor: isDark ? 'rgba(255, 255, 255, 0.03)' : '#FFFFFF',
          borderBottomColor: isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)',
        },
      ]}
    >
      {/* Checkbox Touch Target */}
      <TouchableOpacity
        style={styles.checkboxTouch}
        onPress={handleCheckToggle}
        activeOpacity={0.8}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.isChecked }}
        accessibilityLabel={item.isChecked ? `${item.name}, checked off` : `${item.name}, not checked off`}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <View
          style={[
            styles.checkbox,
            {
              borderColor: item.isChecked
                ? theme.primary
                : theme.border,
              backgroundColor: item.isChecked
                ? theme.primary
                : 'transparent',
            },
            item.isChecked && isDark && [styles.checkboxGlow, { shadowColor: theme.primary }],
          ]}
        >
          <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
            {item.isChecked && (
              <Ionicons name="checkmark" size={14} color={isDark ? theme.bg : '#FFFFFF'} />
            )}
          </Animated.View>
        </View>
      </TouchableOpacity>

      {/* Row Content Touch Target */}
      <TouchableOpacity
        style={styles.rowContentTouch}
        onPress={() => onPress(item)}
        onLongPress={() => {
          if (onLongPress) onLongPress(item.id, item.name);
          else onDelete?.(item.id, item.name);
        }}
        activeOpacity={0.7}
      >
        {/* Emoji icon */}
        <View style={styles.emojiContainer}>
          <Text style={styles.emojiText}>{emojiForItem(item.name)}</Text>
        </View>

        {/* Item info */}
        <View style={styles.itemInfo}>
          <View style={styles.itemNameContainer}>
            <Text
              style={[
                styles.itemName,
                item.isChecked && styles.itemNameChecked,
                { color: theme.text },
              ]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
            {item.isChecked && (
              <Animated.View
                style={[
                  styles.strikethrough,
                  { width: strikeWidth, backgroundColor: theme.secondaryText },
                ]}
                pointerEvents="none"
              />
            )}
          </View>
          {item.notes ? (
            <Text style={[styles.itemNotes, { color: theme.secondaryText }]} numberOfLines={1}>
              {item.notes}
            </Text>
          ) : null}
        </View>

        {/* Quantity stepper or badge */}
        {onQuantityChange ? (
          <QuantityStepper
            quantity={item.quantity}
            unit={item.unit}
            onIncrement={() => onQuantityChange(item.id, 1)}
            onDecrement={() => onQuantityChange(item.id, -1)}
          />
        ) : (
          <View style={[styles.quantityBadge, { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.08)' : '#F5F0E8' }]}>
            <Text style={[styles.quantityText, { color: theme.secondaryText }]}>
              {item.quantity} {item.unit}
            </Text>
          </View>
        )}

        {/* Price */}
        {priceInfo && !priceLoading ? (
          <View style={styles.priceContainer}>
            {priceInfo.amount != null && (
              <Text style={[styles.priceText, { color: priceInfo.tone === 'ok' ? theme.primary : theme.warning }]}>
                ${priceInfo.amount.toFixed(2)}
              </Text>
            )}
            <Text
              style={[styles.priceCaption, { color: priceInfo.tone === 'held' ? theme.warning : theme.secondaryText }]}
              numberOfLines={2}
            >
              {priceInfo.caption}
            </Text>
          </View>
        ) : null}
      </TouchableOpacity>
    </View>
  );
});

export default ItemRow;

const styles = StyleSheet.create({
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  itemRowChecked: {
    opacity: 0.5,
  },
  checkboxTouch: {
    width: 40,
    paddingVertical: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rowContentTouch: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxGlow: {
    shadowColor: '#00E676',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
  },
  emojiContainer: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  emojiText: {
    fontSize: 24,
  },
  itemInfo: {
    flex: 1,
    marginRight: 8,
  },
  itemNameContainer: {
    position: 'relative',
    alignSelf: 'flex-start',
  },
  itemName: {
    fontSize: 15,
    fontWeight: '500',
  },
  itemNameChecked: {
    opacity: 0.6,
  },
  strikethrough: {
    position: 'absolute',
    left: 0,
    top: '50%',
    height: 1.5,
    borderRadius: 1,
  },
  itemNotes: {
    fontSize: 12,
    marginTop: 2,
  },
  quantityBadge: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginRight: 8,
  },
  quantityText: {
    fontSize: 12,
    fontWeight: '600',
  },
  priceContainer: {
    alignItems: 'flex-end',
    minWidth: 50,
    maxWidth: 140,
  },
  priceCaption: {
    fontSize: 10,
    textAlign: 'right',
  },
  priceText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
