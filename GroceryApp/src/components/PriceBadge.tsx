/**
 * PriceBadge — Compact price display component for grocery item rows.
 *
 * Displays:
 *  - Regular price: "$3.49" in grey
 *  - Sale: "~~$4.99~~  $3.49" with strikethrough, green savings badge
 *  - Unit price: tiny grey text below "$1.50/100g"
 *  - Evidence badge: where the price came from and how current it is
 *    ("Flyer · ends Oct 9", "Crowd · 3d ago", "Demo")
 *  - "FAKE SALE" in red if unitPriceVsRegular > 0
 *  - Loading shimmer when isLoading is true
 *  - Empty space when no price data
 */

import React from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import type { PriceResult } from '../pricing/types';
import { formatUnitPrice } from '../pricing/normalizer';
import { describeEvidence } from '../pricing/basket';
import { useActiveTheme } from '../state/useThemeStore';

// ─── Props ──────────────────────────────────────────────────────────────────

interface PriceBadgeProps {
  price: PriceResult | null;
  isLoading?: boolean;
}

// ─── Source Badge Color Map ────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  crowdsourced: '#FF9800',
  instacart: '#4CAF50',
  scraping: '#9C27B0',
  'flyer-scan': '#2196F3',
  'flipp-deals': '#2196F3',
};

/** Seeded demo prices get a neutral badge so they never look like real data. */
const DEMO_COLOR = '#757575';

// ─── Shimmer / Skeleton ────────────────────────────────────────────────────

function ShimmerBadge() {
  const isDark = useActiveTheme() === 'dark';
  return (
    <View style={styles.badgeContainer}>
      <View style={[styles.skeletonLine, { backgroundColor: isDark ? '#334155' : '#e0e0e0' }]} />
      <View style={[styles.skeletonLine, { width: 40, marginTop: 3, backgroundColor: isDark ? '#334155' : '#e0e0e0' }]} />
    </View>
  );
}

// ─── PriceBadge Component ──────────────────────────────────────────────────

export default function PriceBadge({ price, isLoading }: PriceBadgeProps) {
  const isDark = useActiveTheme() === 'dark';

  if (isLoading) {
    return <ShimmerBadge />;
  }

  if (!price) {
    return null; // empty space
  }

  const { saleInfo, source } = price;
  const isFakeSale = saleInfo && saleInfo.unitPriceVsRegular > 0;
  const isGenuineSale = saleInfo && saleInfo.isOnSale && !isFakeSale;

  const sourceColor = price.isDemo ? DEMO_COLOR : SOURCE_COLORS[source.adapterId] ?? '#999';
  const sourceLabel = describeEvidence(price);

  // Format the unit price using the normalizer
  const displayUnit = price.displayUnit ?? '/' + price.unit;
  const unitPriceStr = price.unit
    ? formatUnitPrice(price.unitPrice, displayUnit)
    : '';

  // Format the regular price for display
  const formatPrice = (val: number) => `$${val.toFixed(2)}`;

  return (
    <View style={styles.badgeContainer}>
      {/* Sale or regular price */}
      <View style={styles.priceRow}>
        {isGenuineSale && saleInfo ? (
          <View style={styles.saleRow}>
            <Text style={[styles.regularPrice, { color: isDark ? '#94A3B8' : '#666' }]}>
              ~~{formatPrice(saleInfo.regularPrice)}~~
            </Text>
            <Text style={[styles.salePrice, { color: isDark ? '#34D399' : '#2E7D32' }]}>
              {' '}{formatPrice(price.price)}
            </Text>
            {saleInfo.savingsPercent > 0 && (
              <View style={[styles.savingsBadge, { backgroundColor: isDark ? 'rgba(16,185,129,0.2)' : '#C8E6C9' }]}>
                <Text style={[styles.savingsText, { color: isDark ? '#34D399' : '#2E7D32' }]}>
                  -{saleInfo.savingsPercent}%
                </Text>
              </View>
            )}
          </View>
        ) : (
          <Text style={isFakeSale ? styles.fakeSalePrice : [styles.regularPrice, { color: isDark ? '#94A3B8' : '#666' }]}>
            {formatPrice(price.price)}
          </Text>
        )}

        {/* Fake sale indicator */}
        {isFakeSale && (
          <Text style={styles.fakeSaleLabel}> FAKE SALE</Text>
        )}
      </View>

      {/* Unit price */}
      {unitPriceStr ? (
        <Text style={[styles.unitPrice, { color: isDark ? '#64748B' : '#aaa' }]}>{unitPriceStr}</Text>
      ) : null}

      {/* Source badge */}
      <View style={[styles.sourceBadge, { backgroundColor: sourceColor }]}>
        <Text style={styles.sourceBadgeText}>{sourceLabel}</Text>
      </View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  badgeContainer: {
    alignItems: 'flex-end',
    marginLeft: 8,
    minWidth: 60,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
  },
  regularPrice: {
    fontSize: 13,
    color: '#666',
    fontWeight: '600',
  },
  salePrice: {
    fontSize: 13,
    color: '#2E7D32',
    fontWeight: '700',
  },
  saleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
  },
  savingsBadge: {
    backgroundColor: '#C8E6C9',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginLeft: 4,
  },
  savingsText: {
    fontSize: 9,
    color: '#2E7D32',
    fontWeight: '700',
  },
  fakeSalePrice: {
    fontSize: 13,
    color: '#D32F2F',
    fontWeight: '600',
  },
  fakeSaleLabel: {
    fontSize: 8,
    color: '#D32F2F',
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  unitPrice: {
    fontSize: 9,
    color: '#aaa',
    marginTop: 1,
  },
  sourceBadge: {
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginTop: 2,
  },
  sourceBadgeText: {
    fontSize: 8,
    color: '#fff',
    fontWeight: '600',
  },
  skeletonLine: {
    width: 50,
    height: 10,
    backgroundColor: '#e0e0e0',
    borderRadius: 4,
  },
});