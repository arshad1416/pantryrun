/**
 * GroceryListScreen — Antigravity redesign.
 * Main list view with search bar, category pills, store card row,
 * items grouped by category with quantity steppers, and bottom tab bar.
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  SectionList,
  LayoutAnimation,
  Platform,
  UIManager,
  RefreshControl,
  ScrollView,
  FlatList,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useIsFocused } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import type { GroceryItem, GroceryCategory } from '../types';
import type { PriceResult } from '../pricing/types';
import { friendlyError } from '../utils/friendlyError';
import { BUILT_IN_CATEGORIES, STORE_PLAN_CATEGORY_ORDER } from '../types';
import { useGroceryStore } from '../state/useGroceryStore';
import { getListMeta, yjsSweepExpiredClaims } from '../sync/yjs-adapter';
import type { RootStackParamList } from '../navigation/deepLinks';
import AddItemSheet from './AddItemSheet';
import FlyerScanFlow from '../components/FlyerScanFlow';
import StopOptimizer from '../components/StopOptimizer';
import ChecklistImportSheet from '../components/ChecklistImportSheet';
import UndoToast from '../components/UndoToast';
import { usePriceStore } from '../pricing/price-store';
import { useThemeStore, useActiveTheme } from '../state/useThemeStore';
import { proposalsFromAnalysis } from '../pricing/stop-optimizer';
import { analyzeBasket, planForStores, selectBasketItems, type PlanContext } from '../pricing/basket';
import { addLocalDays, deviceTimeZone, localDate } from '../pricing/eligibility';
import type { PlanOptions } from '../components/StopOptimizer';
import { flippDealsAdapter } from '../pricing/flipp-deals-adapter';
import { crowdsourcedAdapter } from '../pricing/crowdsourced';
import { getSettings, updateSettings } from '../config/settings';
import { fetchDealsForFSA, matchListItems, type FlippDealRow, type DealMatch } from '../services/dealMatcher';
import { isTursoReady } from '../services/tursoClient';

// Extracted components
import SyncIndicator from '../components/SyncIndicator';
import ItemRow from '../components/ItemRow';
import CategoryHeader from '../components/CategoryHeader';
import GotItHeader from '../components/GotItHeader';
import type { StoreTotal } from '../components/StoreTotalBar';
import { themeColors } from '../components/groceryTheme';
import {
  useEntitlementStore,
  purchasePlus,
  restorePlus,
  PLUS_PAYWALL_COPY,
  PLUS_PRICE_DISPLAY,
} from '../config/entitlements';

// New Antigravity components
import SearchBar from '../components/SearchBar';
import CategoryPill from '../components/CategoryPill';
import StoreCard from '../components/StoreCard';
import BottomTabBar, { type TabName } from '../components/BottomTabBar';

/**
 * Trip Optimizer (StopOptimizer → TripPlanSheet) is the paid tier's hero
 * feature. It shipped OFF in v1 (fully free, no IAP — Apple 3.1.1 rejects
 * visible paid features that can't be bought). PantryRun Plus (1.x) turns it
 * on behind the real entitlement check below: the flag says the feature
 * exists in this build; `isPlus` (from src/config/entitlements.ts, the ONLY
 * module that computes entitlement state) says this family paid for it.
 */
const TRIP_OPTIMIZER_ENABLED = true;

// Enable LayoutAnimation on Android
if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type Props = NativeStackScreenProps<RootStackParamList, 'GroceryList'>;
interface ListSection {
  title: string;
  data: GroceryItem[];
  subtotal?: number;
}

export default function GroceryListScreen({ route, navigation }: Props) {
  const { listId } = route.params;
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();

  const themeMode = useThemeStore((s) => s.themeMode);
  const activeTheme = useActiveTheme();
  const isDark = activeTheme === 'dark';
  const theme = isDark ? themeColors.dark : themeColors.light;

  // Stores
  const items = useGroceryStore((s) => s.items);
  const isLoading = useGroceryStore((s) => s.isLoading);
  const error = useGroceryStore((s) => s.error);
  const loadItems = useGroceryStore((s) => s.loadItems);
  const toggleChecked = useGroceryStore((s) => s.toggleChecked);
  const deleteItem = useGroceryStore((s) => s.deleteItem);
  const reorderItem = useGroceryStore((s) => s.reorderItem);
  const claimItem = useGroceryStore((s) => s.claimItem);
  const unclaimItem = useGroceryStore((s) => s.unclaimItem);

  // PantryRun Plus — entitlement state is computed ONLY in
  // src/config/entitlements.ts; this screen just reads and routes to it.
  const isPlus = useEntitlementStore((s) => s.isPlus);
  const handlePlusUpsell = useCallback(() => {
    Alert.alert('PantryRun Plus', PLUS_PAYWALL_COPY, [
      {
        text: `Subscribe • ${PLUS_PRICE_DISPLAY}`,
        onPress: () => {
          purchasePlus().then((ok) => {
            if (!ok) {
              const err = useEntitlementStore.getState().lastError;
              if (err) Alert.alert('Purchase failed', err);
            }
          });
        },
      },
      {
        text: 'Restore Purchase',
        onPress: () => {
          restorePlus().then((ok) => {
            if (!ok) {
              const err = useEntitlementStore.getState().lastError;
              if (err) Alert.alert('Restore failed', err);
            }
          });
        },
      },
      { text: 'Not Now', style: 'cancel' },
    ]);
  }, []);

  // Price store
  const priceLoading = usePriceStore((s) => s.isLoading);
  const itemLoading = usePriceStore((s) => s.itemLoading);
  const loadPricesForAllStores = usePriceStore((s) => s.loadPricesForAllStores);
  const perStorePrices = usePriceStore((s) => s.perStorePrices);
  const isRefreshingPrices = usePriceStore((s) => s.isRefreshing);
  const refreshAllPrices = usePriceStore((s) => s.refreshAllPrices);
  const priceTimestamps = usePriceStore((s) => s.priceTimestamps);

  // Local state
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFlyerScan, setShowFlyerScan] = useState(false);
  const [listName, setListName] = useState('Grocery List');
  const [gotItExpanded, setGotItExpanded] = useState(false);
  const [toastState, setToastState] = useState<{
    visible: boolean;
    message: string;
    itemId: string;
  } | null>(null);
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);
  const [selectedRouteNumStops, setSelectedRouteNumStops] = useState<number | null>(null);
  const [availableStores, setAvailableStores] = useState<{ storeId: string; storeName: string }[]>([]);
  const [priceSummaryItem, setPriceSummaryItem] = useState<{ id: string; name: string } | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [activeTab, setActiveTab] = useState<TabName>('lists');

  // Flyer deals states & matched calculation
  const [fsaDeals, setFsaDeals] = useState<FlippDealRow[]>([]);
  const [fsaDealsLoading, setFsaDealsLoading] = useState(false);
  const [fsaDealsError, setFsaDealsError] = useState<string | null>(null);

  const matchedDealsMap = useMemo(() => {
    if (fsaDeals.length === 0) return new Map<string, DealMatch[]>();
    const activeListItems = Object.values(items)
      .filter((item) => !item.isDeleted && item.listId === listId && !item.isChecked);
    return matchListItems(activeListItems, fsaDeals);
  }, [items, listId, fsaDeals]);

  // Build dynamic store name map from available stores
  const storeNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of availableStores) map[s.storeId] = s.storeName;
    return map;
  }, [availableStores]);

  // The basket: unchecked, undeleted items on this list with a quantity
  // other than 0. Prices are fetched and compared for these only —
  // checked items are already in the cart.
  const basketItems = useMemo(() => selectBasketItems(items, listId), [items, listId]);

  // The clock the plan is evaluated at. Ticks every minute (and on focus),
  // so an offer that expires while the list is open stops counting even if
  // nothing else changes.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (isFocused) setClock(Date.now());
  }, [isFocused]);

  const [planOptions, setPlanOptions] = useState<PlanOptions>({
    maxStops: 3,
    shoppingDay: 'today',
    memberships: [],
    requireHeld: false,
  });

  const planCtx = useMemo<PlanContext>(() => {
    const timeZone = deviceTimeZone();
    const today = localDate(clock, timeZone);
    const from = planOptions.shoppingDay === 'tomorrow' ? addLocalDays(today, 1) : today;
    const through = planOptions.shoppingDay === 'week' ? addLocalDays(today, 6) : from;
    return {
      now: clock,
      timeZone,
      shoppingDate: from,
      shoppingThrough: through,
      includeDemo: __DEV__,
      memberships: planOptions.memberships,
      requireHeldItems: planOptions.requireHeld,
    };
  }, [clock, planOptions.shoppingDay, planOptions.memberships, planOptions.requireHeld]);

  // One analysis of the whole basket: eligibility on the shopping date,
  // variant / sale-only rules, and purchase math. Store cards, route cards,
  // route sections, price badges and Plan My Trip all read from it.
  const analysis = useMemo(
    () => analyzeBasket(basketItems, perStorePrices, planCtx),
    [basketItems, perStorePrices, planCtx],
  );

  const stopProposals = useMemo(
    () => proposalsFromAnalysis(analysis, storeNameMap, planOptions.maxStops, planCtx),
    [analysis, storeNameMap, planOptions.maxStops, planCtx],
  );

  // Where each basket item is cheapest across every store, and across the
  // selected route — the same assignment the totals were computed from.
  const bestLines = useMemo(() => planForStores(analysis, analysis.storeIds), [analysis]);
  const selectedRoute = useMemo(() => {
    if (!selectedRouteNumStops) return null;
    return stopProposals.find((p) => p.numStops === selectedRouteNumStops) ?? null;
  }, [selectedRouteNumStops, stopProposals]);

  const getItemPrice = useCallback(
    (itemId: string): PriceResult | null => {
      const entry = analysis.items.find((a) => a.item.id === itemId);
      if (selectedStoreId) return entry?.options.find((o) => o.storeId === selectedStoreId)?.offer ?? null;
      const plan = selectedRoute?.plan ?? bestLines;
      return plan.lines.find((l) => l.itemId === itemId)?.option?.offer ?? null;
    },
    [analysis, selectedStoreId, selectedRoute, bestLines],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      // Actually release claims past the 30-min expiry (syncs to the family
      // via the normal Yjs path), then advance the clock so claim badges and
      // offer expiry update.
      try {
        yjsSweepExpiredClaims(listId);
      } catch {
        // Yjs doc not yet hydrated — nothing to sweep
      }
      setClock(Date.now());
    }, 60_000);
    return () => clearInterval(timer);
  }, [listId]);

  useEffect(() => {
    loadItems(listId).catch((err: Error) => {
      Alert.alert('Something went wrong', friendlyError(err));
    });

    try {
      const meta = getListMeta(listId);
      const name = meta.get('name') as string | undefined;
      if (name) {
        setListName(name);
      }
    } catch {
      // Yjs doc not yet hydrated — use default
    }
  }, [listId, loadItems]);

  useEffect(() => {
    Promise.all([
      flippDealsAdapter.getAvailableStores().catch(() => [] as { storeId: string; storeName: string }[]),
      crowdsourcedAdapter.getAvailableStores().catch(() => [] as { storeId: string; storeName: string }[]),
    ]).then(([flippStores, crowdStores]) => {
      const all = [...flippStores, ...crowdStores];
      const seen = new Set<string>();
      const unique = all.filter(s => {
        if (seen.has(s.storeId)) return false;
        seen.add(s.storeId);
        return true;
      });
      setAvailableStores(unique);
    }).catch(err => console.warn('[stores] Failed to load stores:', err));
  }, []);

  // Fetch prices for basket items whose price is missing, older than an hour,
  // or was fetched under a different name (a rename is a different product).
  const fetchedNames = useRef<Record<string, string>>({});
  const basketKey = useMemo(
    () => basketItems.map((i) => `${i.id}:${i.name}`).sort().join('|'),
    [basketItems],
  );
  useEffect(() => {
    const storeIds = availableStores.map(s => s.storeId);
    if (storeIds.length === 0 || basketItems.length === 0) return;
    const FRESHNESS_THRESHOLD = 60 * 60 * 1000;
    const toFetch = basketItems.filter((item) => {
      const ts = priceTimestamps[item.id];
      const fetchedAs = fetchedNames.current[item.id];
      if (ts && fetchedAs === undefined) fetchedNames.current[item.id] = item.name;
      return !ts || Date.now() - ts > FRESHNESS_THRESHOLD ||
        (fetchedAs !== undefined && fetchedAs !== item.name);
    });
    if (toFetch.length > 0) {
      for (const item of toFetch) fetchedNames.current[item.id] = item.name;
      loadPricesForAllStores(
        toFetch.map((item) => ({ id: item.id, name: item.name })),
        storeIds,
      ).catch(err => console.warn('[prices] loadPricesForAllStores failed:', err));
    }
  }, [basketKey, listId, loadPricesForAllStores, isFocused, availableStores]);

  // Available categories from items
  const availableCategories = useMemo(() => {
    const cats = new Set<string>();
    Object.values(items)
      .filter((i) => !i.isDeleted && i.listId === listId && !i.isChecked)
      .forEach((i) => cats.add(i.category || 'other'));
    const builtIn = [...BUILT_IN_CATEGORIES] as string[];
    // When list is empty, show All + all built-in categories so pills are visible
    if (cats.size === 0) {
      return ['All', 'produce', 'dairy', 'meat', 'bakery', 'frozen'];
    }
    return ['All', ...builtIn.filter(c => cats.has(c)), ...Array.from(cats).filter(c => !builtIn.includes(c)).sort()];
  }, [items, listId]);

  // Grouped sections
  const groupedSections = useMemo(() => {
    const allItems = Object.values(items).filter(
      (item) => !item.isDeleted && item.listId === listId,
    );

    const filtered = searchQuery.trim()
      ? allItems.filter((item) =>
          item.name.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : allItems;

    // Filter by active category
    const categoryFiltered = activeCategory === 'All'
      ? filtered
      : filtered.filter((item) => (item.category || 'other') === activeCategory);

    categoryFiltered.sort((a, b) => a.sortOrder - b.sortOrder);

    const unchecked = categoryFiltered.filter((item) => !item.isChecked);
    const checked = categoryFiltered.filter((item) => item.isChecked);

    const groups: Record<string, GroceryItem[]> = {};
    for (const item of unchecked) {
      const cat = item.category || 'other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(item);
    }

    const sections: ListSection[] = [];
    const builtInSet = new Set(BUILT_IN_CATEGORIES);

    for (const cat of BUILT_IN_CATEGORIES) {
      if (groups[cat]) {
        sections.push({ title: cat, data: groups[cat] });
        delete groups[cat];
      }
    }

    for (const cat of Object.keys(groups).sort()) {
      sections.push({ title: cat, data: groups[cat] });
    }

    if (checked.length > 0) {
      sections.push({
        title: '__got_it__',
        data: gotItExpanded ? checked : [],
      });
    }

    return sections;
  }, [items, listId, searchQuery, gotItExpanded, activeCategory]);

  // Store totals — each store's total covers only the lines it can price, so
  // sort coverage-first: a cheap partial basket never outranks a full one.
  const storeTotals = useMemo(() => {
    const totals: StoreTotal[] = analysis.storeIds.map((storeId) => {
      const plan = planForStores(analysis, [storeId]);
      return {
        storeId,
        storeName: storeNameMap[storeId] ?? storeId,
        total: plan.totalCents / 100,
        coveredCount: plan.costedCount,
        totalCount: plan.totalCount,
      };
    });
    totals.sort((a, b) => b.coveredCount - a.coveredCount || a.total - b.total || a.storeId.localeCompare(b.storeId));
    return totals;
  }, [analysis, storeNameMap]);

  // Store-plan sections
  const storePlanSections = useMemo(() => {
    if (!selectedStoreId) return null;

    const allItems = Object.values(items).filter(
      (item) => !item.isDeleted && item.listId === listId,
    );

    const filtered = searchQuery.trim()
      ? allItems.filter((item) =>
          item.name.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : allItems;

    filtered.sort((a, b) => a.sortOrder - b.sortOrder);

    const unchecked = filtered.filter((item) => !item.isChecked);
    const checked = filtered.filter((item) => item.isChecked);

    const groups: Record<string, GroceryItem[]> = {};
    for (const item of unchecked) {
      const cat = item.category || 'other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(item);
    }

    const sections: ListSection[] = [];

    for (const cat of STORE_PLAN_CATEGORY_ORDER) {
      if (groups[cat]) {
        sections.push({ title: cat, data: groups[cat] });
        delete groups[cat];
      }
    }

    for (const cat of Object.keys(groups).sort()) {
      sections.push({ title: cat, data: groups[cat] });
    }

    if (checked.length > 0) {
      sections.push({
        title: '__got_it__',
        data: gotItExpanded ? checked : [],
      });
    }

    return sections;
  }, [items, listId, searchQuery, gotItExpanded, selectedStoreId]);

  // Route-plan sections — grouped by the same plan the route card's total
  // was computed from.
  const routePlanSections = useMemo(() => {
    if (!selectedRoute) return null;
    const { plan, stores } = selectedRoute;
    const lineById = new Map(plan.lines.map((l) => [l.itemId, l]));

    const allItems = Object.values(items).filter(
      (item) => !item.isDeleted && item.listId === listId,
    );

    const filtered = searchQuery.trim()
      ? allItems.filter((item) =>
          item.name.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : allItems;

    const unchecked = filtered.filter((item) => !item.isChecked);
    const checked = filtered.filter((item) => item.isChecked);

    const storeGroups: Record<string, GroceryItem[]> = {};
    const storeSubtotals: Record<string, number> = {};
    const heldGroup: GroceryItem[] = [];
    const fallbackGroup: GroceryItem[] = [];

    for (const item of unchecked) {
      const line = lineById.get(item.id);
      if (line?.option) {
        const sid = line.option.storeId;
        (storeGroups[sid] ??= []).push(item);
        storeSubtotals[sid] = (storeSubtotals[sid] ?? 0) + line.option.purchase.costCents / 100;
      } else if (line?.status === 'held') {
        heldGroup.push(item);
      } else if (line) {
        fallbackGroup.push(item);
      }
      // No line: quantity 0 — not part of the basket.
    }

    const sections: ListSection[] = [];

    stores.forEach((store, idx) => {
      const data = storeGroups[store.storeId];
      if (data && data.length > 0) {
        sections.push({
          title: `Stop ${idx + 1}: ${store.storeName}`,
          data,
          subtotal: storeSubtotals[store.storeId],
        });
      }
    });

    if (heldGroup.length > 0) {
      sections.push({
        title: 'Held — sale only, no qualifying sale',
        data: heldGroup,
      });
    }

    if (fallbackGroup.length > 0) {
      sections.push({
        title: 'Not on this route (no usable price)',
        data: fallbackGroup,
      });
    }

    if (checked.length > 0) {
      sections.push({
        title: '__got_it__',
        data: gotItExpanded ? checked : [],
      });
    }

    return sections;
  }, [items, listId, searchQuery, gotItExpanded, selectedRoute]);

  // Flyer scan needs price lookups on. Rather than hide the icon (making the
  // feature undiscoverable), show it always and present the price opt-in
  // disclosure inline when a not-yet-opted-in user taps it.
  const handleFlyerScanPress = useCallback(() => {
    if (getSettings().pricingOptedIn ?? false) {
      setShowFlyerScan(true);
      return;
    }
    Alert.alert(
      'Turn on price lookups to scan flyers?',
      'Flyer scanning reads prices from your photo into your local price list. The photo (with location metadata removed) is sent to your own relay server for extraction and then discarded — your item names and shopping habits never leave this device. You can turn this off anytime in Settings.',
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Turn on & scan',
          onPress: async () => {
            try {
              await updateSettings({ pricingOptedIn: true });
              setShowFlyerScan(true);
            } catch (err) {
              Alert.alert('Could not enable', err instanceof Error ? err.message : 'Please try again.');
            }
          },
        },
      ],
    );
  }, []);

  // Single tap opens the editor directly (the old double-tap — first tap shows
  // a price panel, second tap edits — was undiscoverable). Price details moved
  // to the long-press menu ("View prices").
  const handleItemPress = useCallback(
    (item: GroceryItem) => {
      setPriceSummaryItem(null);
      navigation.navigate('ItemEdit', { listId, itemId: item.id });
    },
    [navigation, listId],
  );

  const [togglingItems, setTogglingItems] = useState<Set<string>>(new Set());
  const handleToggle = useCallback(
    (id: string) => {
      const item = items[id];
      if (!item) return;

      if (togglingItems.has(id)) return;
      setTogglingItems((prev) => new Set(prev).add(id));

      if (!item.isChecked) {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      }

      toggleChecked(id)
        .catch((err: Error) => {
          Alert.alert('Something went wrong', friendlyError(err));
        })
        .finally(() => {
          setTogglingItems((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        });

      if (!item.isChecked) {
        setToastState({
          visible: true,
          message: `${item.name} ✓ checked off`,
          itemId: item.id,
        });
      }
    },
    [items, toggleChecked, togglingItems],
  );

  const handleUndo = useCallback(() => {
    if (!toastState) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    toggleChecked(toastState.itemId).catch((err: Error) => {
      Alert.alert('Something went wrong', friendlyError(err));
    });
    setToastState(null);
  }, [toastState, toggleChecked]);

  const handleDismissToast = useCallback(() => {
    setToastState(null);
  }, []);

  const handleItemLongPress = useCallback(
    (id: string, name: string) => {
      Alert.alert(name, 'What would you like to do?', [
        {
          text: 'Edit',
          onPress: () => {
            navigation.navigate('ItemEdit', { listId, itemId: id });
          },
        },
        {
          text: 'View prices',
          onPress: () => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setPriceSummaryItem({ id, name });
          },
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.alert('Delete Item', `Delete "${name}"?`, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                  deleteItem(id).catch((err: Error) => {
                    Alert.alert('Something went wrong', friendlyError(err));
                  });
                },
              },
            ]);
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [deleteItem, navigation, listId],
  );

  const handleClaim = useCallback(
    (id: string) => {
      claimItem(id);
    },
    [claimItem],
  );

  const handleUnclaim = useCallback(
    (id: string) => {
      unclaimItem(id);
    },
    [unclaimItem],
  );

  const handleMoveUp = useCallback(
    (id: string) => {
      reorderItem(id, 'up', listId).catch((err: Error) => {
        Alert.alert('Something went wrong', friendlyError(err));
      });
    },
    [reorderItem, listId],
  );

  const handleMoveDown = useCallback(
    (id: string) => {
      reorderItem(id, 'down', listId).catch((err: Error) => {
        Alert.alert('Something went wrong', friendlyError(err));
      });
    },
    [reorderItem, listId],
  );

  const handleSettings = useCallback(() => {
    navigation.navigate('Settings');
  }, [navigation]);

  const handleRefreshPrices = useCallback(() => {
    const storeIds = availableStores.map(s => s.storeId);
    if (storeIds.length === 0) return;
    if (basketItems.length > 0) {
      for (const item of basketItems) fetchedNames.current[item.id] = item.name;
      refreshAllPrices(
        basketItems.map((item) => ({ id: item.id, name: item.name })),
        storeIds,
      ).catch(() => {});
    }
  }, [basketItems, availableStores, refreshAllPrices]);

  const handleQuantityChange = useCallback(
    (id: string, delta: number) => {
      const item = items[id];
      if (!item) return;
      const newQty = Math.max(1, item.quantity + delta);
      // Update quantity via the store
      const { updateItem } = useGroceryStore.getState();
      if (updateItem) {
        updateItem(id, { quantity: newQty }).catch((err: Error) => {
          Alert.alert('Something went wrong', friendlyError(err));
        });
      }
    },
    [items],
  );

  const loadFsaDeals = useCallback(async () => {
    setFsaDealsLoading(true);
    setFsaDealsError(null);
    try {
      const settings = getSettings();
      const fsa = settings.flippFsa;
      if (!fsa) {
        setFsaDealsError('fsa_missing');
        setFsaDealsLoading(false);
        return;
      }
      if (!isTursoReady()) {
        setFsaDealsError('turso_missing');
        setFsaDealsLoading(false);
        return;
      }
      const fetched = await fetchDealsForFSA(fsa);
      setFsaDeals(fetched);
    } catch (err) {
      setFsaDealsError(err instanceof Error ? err.message : 'Failed to load flyer deals');
    } finally {
      setFsaDealsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'deals') {
      loadFsaDeals();
    }
  }, [activeTab, loadFsaDeals]);

  const handleTabPress = useCallback((tab: TabName) => {
    if (tab === 'account') {
      navigation.navigate('Settings');
      setActiveTab('lists');
      return;
    }
    
    if (tab === 'scan') {
      setShowAddSheet(true);
      return;
    }
    
    if (tab === 'deals') {
      setActiveTab('deals');
      return;
    }
    
    if (tab === 'home' || tab === 'lists') {
      if (activeTab === 'deals') {
        setActiveTab('lists');
      } else {
        navigation.goBack();
      }
    }
  }, [activeTab, navigation]);

  const hasPrices = Object.keys(priceTimestamps).length > 0;

  if (isLoading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.bg }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.secondaryText }]}>Loading items...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.bg }]}>
        <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          style={[styles.retryButton, { backgroundColor: theme.primary }]}
          onPress={() => loadItems(listId)}
        >
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const renderMatchedDealsView = () => {
    const settings = getSettings();
    const fsa = (settings as any).flippFsa;

    const activeListItems = Object.values(items)
      .filter((item) => !item.isDeleted && item.listId === listId && !item.isChecked);

    if (fsaDealsLoading) {
      return (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.secondaryText, marginTop: 12 }]}>
            Matching flyer deals...
          </Text>
        </View>
      );
    }

    if (fsaDealsError === 'fsa_missing' || fsaDealsError === 'turso_missing' || (!fsa && !fsaDealsError)) {
      return (
        <View style={styles.emptyContainer}>
          <Ionicons name="pricetag-outline" size={48} color={theme.secondaryText} />
          <Text style={[styles.emptyTitle, { color: theme.text, marginTop: 12 }]}>
            Flyer Matching Unconfigured
          </Text>
          <Text style={[styles.emptySubtitle, { color: theme.secondaryText, textAlign: 'center', marginBottom: 20 }]}>
            {!fsa
              ? 'Please configure your FSA (postal code prefix) in settings to match list items with flyer deals.'
              : 'Please connect a Turso database in settings to match list items with flyer deals.'}
          </Text>
          <TouchableOpacity
            style={[styles.createBtn, { backgroundColor: theme.primary }]}
            onPress={() => navigation.navigate('Settings')}
          >
            <Text style={styles.createBtnText}>Go to Settings</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (fsaDealsError) {
      return (
        <View style={styles.emptyContainer}>
          <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
          <Text style={[styles.emptyTitle, { color: '#EF4444', marginTop: 12 }]}>Failed to load deals</Text>
          <Text style={[styles.emptySubtitle, { color: theme.secondaryText }]}>{fsaDealsError}</Text>
          <TouchableOpacity style={[styles.createBtn, { backgroundColor: theme.primary }]} onPress={loadFsaDeals}>
            <Text style={styles.createBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }

    const itemsWithMatches = activeListItems.filter((item) => {
      const matches = matchedDealsMap.get(item.id);
      return matches && matches.length > 0;
    });

    if (itemsWithMatches.length === 0) {
      return (
        <View style={styles.emptyContainer}>
          <Ionicons name="pricetags-outline" size={48} color={theme.secondaryText} />
          <Text style={[styles.emptyTitle, { color: theme.text, marginTop: 12 }]}>
            No deals matched
          </Text>
          <Text style={[styles.emptySubtitle, { color: theme.secondaryText, textAlign: 'center' }]}>
            We couldn't find any flyer deals in your area (FSA: {fsa}) for the items on your list.
          </Text>
        </View>
      );
    }

    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20, paddingVertical: 12 }}>
          <Text style={{ fontSize: 13, color: theme.secondaryText }}>
            Matched flyer deals for your shopping list items (FSA: <Text style={{ color: theme.primary, fontWeight: 'bold' }}>{fsa}</Text>)
          </Text>
        </View>

        {itemsWithMatches.map((item) => {
          const matches = matchedDealsMap.get(item.id) || [];
          return (
            <View key={item.id} style={{ marginHorizontal: 16, marginVertical: 8 }}>
              <Text style={{ fontSize: 16, fontWeight: 'bold', color: theme.text, marginBottom: 8, marginLeft: 4 }}>
                {item.name}
              </Text>
              
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 4 }}>
                {matches.map((deal, idx) => (
                  <View
                    key={`${deal.merchant}-${idx}`}
                    style={[
                      styles.matchedDealCard,
                      {
                        backgroundColor: theme.cardBg,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    {deal.imageUrl ? (
                      <Image source={{ uri: deal.imageUrl }} style={styles.matchedDealImage} resizeMode="contain" />
                    ) : (
                      <View style={[styles.matchedDealPlaceholder, { backgroundColor: theme.inputBg }]}>
                        <Ionicons name="fast-food-outline" size={16} color={theme.secondaryText} />
                      </View>
                    )}
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={[styles.matchedDealMerchant, { color: theme.primary }]}>
                        {deal.merchant}
                      </Text>
                      <Text style={[styles.matchedDealName, { color: theme.text }]} numberOfLines={2}>
                        {deal.itemName}
                      </Text>
                      <Text style={[styles.matchedDealPrice, { color: theme.accent }]}>
                        {deal.price}
                      </Text>
                      {deal.validTo && (
                        <Text style={{ fontSize: 9, color: theme.secondaryText, marginTop: 2 }}>
                          Ends {new Date(deal.validTo).toLocaleDateString()}
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
              </ScrollView>
            </View>
          );
        })}
      </ScrollView>
    );
  };

  const totalItems = Object.values(items).filter(
    (i) => !i.isDeleted && i.listId === listId,
  ).length;

  const checkedItemsCount = Object.values(items).filter(
    (i) => {
      if (i.isDeleted || i.listId !== listId || !i.isChecked) return false;
      if (searchQuery.trim()) {
        return i.name.toLowerCase().includes(searchQuery.toLowerCase());
      }
      return true;
    },
  ).length;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={24} color={theme.primary} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>{listName}</Text>
        <View style={styles.headerRight}>
          <SyncIndicator listId={listId} />
          {/* Flyer scan requires BOTH the feature toggle and the AC-14 pricing
              opt-in — without the latter the registry returns no prices and a
              scan would appear to silently do nothing. */}
          {(getSettings().flyerScanEnabled ?? false) && (
            <TouchableOpacity
              onPress={handleFlyerScanPress}
              style={styles.settingsBtn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Scan a store flyer for prices"
            >
              <Ionicons name="camera-outline" size={22} color={theme.text} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleSettings} style={styles.settingsBtn} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Settings">
            <Ionicons name="settings-outline" size={22} color={theme.text} />
          </TouchableOpacity>
        </View>
      </View>

      {activeTab === 'lists' ? (
        <>
          {/* Search bar */}
          <SearchBar value={searchQuery} onChangeText={setSearchQuery} placeholder="Search groceries..." />

          {/* Store card row — horizontal scroll */}
          {(storeTotals.length > 0 || availableStores.length > 0) && (
            <View style={styles.storeCardRow}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.storeCardScroll}
              >
                {storeTotals.length > 0 ? storeTotals.map((st) => (
                  <StoreCard
                    key={st.storeId}
                    storeName={st.storeName}
                    storeId={st.storeId}
                    total={st.total}
                    coveredCount={st.coveredCount}
                    totalCount={st.totalCount}
                    isSelected={selectedStoreId === st.storeId}
                    onPress={() => {
                      if (selectedStoreId === st.storeId) {
                        setSelectedStoreId(null);
                      } else {
                        setSelectedStoreId(st.storeId);
                        setSelectedRouteNumStops(null);
                      }
                    }}
                  />
                )) : availableStores.map((s) => (
                  <StoreCard
                    key={s.storeId}
                    storeName={s.storeName}
                    storeId={s.storeId}
                    total={0}
                    coveredCount={0}
                    totalCount={basketItems.length}
                    isSelected={selectedStoreId === s.storeId}
                    onPress={() => {
                      if (selectedStoreId === s.storeId) {
                        setSelectedStoreId(null);
                      } else {
                        setSelectedStoreId(s.storeId);
                        setSelectedRouteNumStops(null);
                      }
                    }}
                  />
                ))}
              </ScrollView>
            </View>
          )}

          {/* Category pills */}
          <View style={styles.categoryPillContainer}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.categoryPillScroll}
            >
              {availableCategories.map((cat) => (
                <CategoryPill
                  key={cat}
                  label={cat === 'All' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
                  isActive={activeCategory === cat}
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setActiveCategory(cat);
                  }}
                />
              ))}
            </ScrollView>
          </View>

          {/* Trip Optimizer — PantryRun Plus. The render gate is the flag
              (feature exists in this build) AND the entitlement (family
              paid), computed solely by src/config/entitlements.ts. */}
          {TRIP_OPTIMIZER_ENABLED && isPlus && (
            <StopOptimizer
              items={basketItems}
              analysis={analysis}
              proposals={stopProposals}
              storeNameMap={storeNameMap}
              options={planOptions}
              onChangeOptions={setPlanOptions}
              now={clock}
              selectedRouteNumStops={selectedRouteNumStops}
              onSelectRouteNumStops={(numStops) => {
                setSelectedRouteNumStops(numStops);
                setSelectedStoreId(null);
              }}
            />
          )}

          {/* PantryRun Plus upsell — shown where the Trip Optimizer would be */}
          {TRIP_OPTIMIZER_ENABLED && !isPlus && (
            <TouchableOpacity
              style={[styles.findPricesBtn, { backgroundColor: isDark ? 'rgba(255, 193, 7, 0.10)' : 'rgba(255, 179, 0, 0.12)' }]}
              onPress={handlePlusUpsell}
              activeOpacity={0.7}
            >
              <Ionicons name="lock-closed" size={14} color={isDark ? '#FFC107' : '#B28704'} />
              <Text style={[styles.findPricesText, { color: isDark ? '#FFC107' : '#B28704' }]}>
                Trip Optimizer — unlock with PantryRun Plus ({PLUS_PRICE_DISPLAY})
              </Text>
            </TouchableOpacity>
          )}
          {/* Find Prices button */}
          {!priceLoading && (
            <TouchableOpacity
              style={[styles.findPricesBtn, { backgroundColor: isDark ? 'rgba(0, 230, 118, 0.08)' : 'rgba(124, 179, 66, 0.1)' }]}
              onPress={handleRefreshPrices}
              activeOpacity={0.7}
            >
              <Ionicons name={hasPrices ? 'refresh' : 'search'} size={14} color={theme.primary} />
              <Text style={[styles.findPricesText, { color: theme.primary }]}>
                {hasPrices ? 'Refresh Prices' : 'Find Prices'}
              </Text>
            </TouchableOpacity>
          )}

          {/* Price summary banner */}
          {priceSummaryItem && (() => {
            const priceEntries = availableStores
              .map((store) => {
                const pr = analysis.items
                  .find((a) => a.item.id === priceSummaryItem.id)
                  ?.options.find((o) => o.storeId === store.storeId)?.offer;
                return pr ? `${store.storeName} $${pr.price.toFixed(2)}` : null;
              })
              .filter(Boolean);
            return (
              <View style={[styles.priceSummaryBanner, {
                backgroundColor: isDark ? 'rgba(255, 255, 255, 0.06)' : '#FFFFFF',
                borderColor: isDark ? 'rgba(0, 230, 118, 0.15)' : 'rgba(0, 0, 0, 0.06)',
              }]}>
                <Text style={[styles.priceSummaryName, { color: theme.text }]}>
                  {priceSummaryItem.name}
                </Text>
                {priceEntries.length > 0 ? (
                  <Text style={[styles.priceSummaryText, { color: theme.secondaryText }]} numberOfLines={2}>
                    {priceEntries.join('  ·  ')}
                  </Text>
                ) : (
                  <Text style={[styles.priceSummaryText, { color: theme.secondaryText }]}>
                    No prices found
                  </Text>
                )}
                <TouchableOpacity
                  style={styles.priceSummaryDismiss}
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setPriceSummaryItem(null);
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close" size={16} color={theme.secondaryText} />
                </TouchableOpacity>
              </View>
            );
          })()}

          {/* Sectioned list */}
          {(() => {
            const activeSections = selectedStoreId && storePlanSections
              ? storePlanSections
              : selectedRouteNumStops && routePlanSections
              ? routePlanSections
              : groupedSections;
            const isStorePlan = selectedStoreId !== null || selectedRouteNumStops !== null;

            if (activeSections.length === 0) {
              return (
                <View style={styles.emptyContainer}>
                  <Ionicons name="cart-outline" size={48} color={theme.secondaryText} />
                  <Text style={[styles.emptyTitle, { color: theme.text, marginTop: 12 }]}>
                    {searchQuery ? 'No results' : 'List is empty'}
                  </Text>
                  <Text style={[styles.emptySubtitle, { color: theme.secondaryText }]}>
                    {searchQuery
                      ? 'Try a different search term'
                      : 'Tap + to add your first item'}
                  </Text>
                </View>
              );
            }
            return (
              <SectionList
                sections={activeSections}
                keyExtractor={(item) => item.id}
                refreshControl={
                  <RefreshControl
                    refreshing={isRefreshingPrices}
                    onRefresh={handleRefreshPrices}
                    tintColor={theme.primary}
                    colors={[theme.primary]}
                  />
                }
                renderItem={({ item, index, section }) => {
                  if (section.title === '__got_it__') {
                    return (
                      <ItemRow
                        item={item}
                        onToggle={handleToggle}
                        onPress={handleItemPress}
                        onLongPress={handleItemLongPress}
                        isFirst={index === 0}
                        isLast={index === section.data.length - 1}
                        price={getItemPrice(item.id)}
                        priceLoading={itemLoading[item.id] ?? false}
                        onQuantityChange={handleQuantityChange}
                      />
                    );
                  }
                  return (
                    <ItemRow
                      item={item}
                      onToggle={handleToggle}
                      onPress={handleItemPress}
                      onLongPress={handleItemLongPress}
                      onMoveUp={isStorePlan ? undefined : handleMoveUp}
                      onMoveDown={isStorePlan ? undefined : handleMoveDown}
                      isFirst={index === 0}
                      isLast={index === section.data.length - 1}
                      price={getItemPrice(item.id)}
                      priceLoading={itemLoading[item.id] ?? false}
                      onQuantityChange={handleQuantityChange}
                    />
                  );
                }}
                renderSectionHeader={({ section }) => {
                  if (section.title === '__got_it__') {
                    return (
                      <GotItHeader
                        count={checkedItemsCount}
                        isExpanded={gotItExpanded}
                        onToggle={() => setGotItExpanded((prev) => !prev)}
                      />
                    );
                  }
                  return (
                    <CategoryHeader
                      category={section.title}
                      count={section.data.length}
                      subtotal={section.subtotal}
                    />
                  );
                }}
                contentContainerStyle={styles.listContent}
                stickySectionHeadersEnabled={false}
                showsVerticalScrollIndicator={false}
              />
            );
          })()}
        </>
      ) : (
        renderMatchedDealsView()
      )}

      {/* Undo Toast */}
      {toastState?.visible && (
        <UndoToast
          message={toastState.message}
          onUndo={handleUndo}
          duration={5000}
          onDismiss={handleDismissToast}
        />
      )}

      {/* Bottom Tab Bar */}
      <BottomTabBar activeTab={activeTab} onTabPress={handleTabPress} />

      {/* FAB Add button — in overlay for touch passthrough */}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <TouchableOpacity
          style={[styles.fab, {
            backgroundColor: theme.primary,
            shadowColor: isDark ? '#00E676' : '#7CB342',
          }]}
          onPress={() => setShowAddSheet(true)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Add grocery item"
        >
          <Ionicons name="add" size={28} color={isDark ? '#0B0F12' : '#FFFFFF'} />
        </TouchableOpacity>
      </View>

      {/* Add Item Sheet */}
      <ChecklistImportSheet
        visible={showImport}
        listId={listId}
        onClose={() => setShowImport(false)}
      />

      <AddItemSheet
        visible={showAddSheet}
        listId={listId}
        // iOS can't present a modal while another is still dismissing.
        onImportChecklist={() => setTimeout(() => setShowImport(true), 400)}
        onClose={() => {
          setShowAddSheet(false);
          setActiveTab('lists');
        }}
        onItemAdded={() => {
          setShowAddSheet(false);
          setActiveTab('lists');
        }}
      />

      {/* Flyer Scan Flow (AI price extraction via relay) */}
      <FlyerScanFlow
        visible={showFlyerScan}
        onClose={() => setShowFlyerScan(false)}
        stores={availableStores}
        theme={theme}
        onComplete={() => {
          handleRefreshPrices();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
  },
  errorText: {
    fontSize: 16,
    color: '#EF4444',
    marginTop: 12,
    marginBottom: 16,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  retryButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 12,
  },
  retryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    flex: 1,
    marginLeft: 8,
  },
  backBtn: {
    paddingRight: 4,
    padding: 4,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  settingsBtn: {
    padding: 6,
  },
  categoryPillContainer: {
    paddingVertical: 4,
  },
  categoryPillScroll: {
    paddingHorizontal: 16,
    gap: 0,
  },
  storeCardRow: {
    paddingVertical: 8,
  },
  storeCardScroll: {
    paddingHorizontal: 16,
  },
  listContent: {
    paddingBottom: 160,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 4,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
  },
  fab: {
      position: 'absolute',
      bottom: 90,
      right: 20,
      width: 56,
      height: 56,
      borderRadius: 28,
      justifyContent: 'center',
      alignItems: 'center',
      elevation: 10,
      zIndex: 999,
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.3,
      shadowRadius: 6,
    },
  findPricesBtn: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  findPricesText: {
    fontSize: 13,
    fontWeight: '600',
  },
  priceSummaryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  priceSummaryName: {
    fontSize: 14,
    fontWeight: '700',
    marginRight: 10,
  },
  priceSummaryText: {
    fontSize: 13,
    flex: 1,
  },
  priceSummaryDismiss: {
    marginLeft: 8,
    padding: 4,
  },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginTop: 12,
  },
  createBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  matchedDealCard: {
    width: 220,
    flexDirection: 'row',
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
    alignItems: 'center',
  },
  matchedDealImage: {
    width: 48,
    height: 48,
    borderRadius: 6,
  },
  matchedDealPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  matchedDealMerchant: {
    fontSize: 9,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  matchedDealName: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 15,
  },
  matchedDealPrice: {
    fontSize: 13,
    fontWeight: 'bold',
    marginTop: 2,
  },
});
