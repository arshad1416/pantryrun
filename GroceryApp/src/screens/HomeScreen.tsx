/**
 * Home Screen — Antigravity redesign.
 * Entry point with bottom tab navigation, search bar, store-style list cards,
 * glassmorphism design, and all existing features (swipe-to-delete, context menu, etc.).
 */

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  GestureResponderEvent,
  Platform,
  Modal,
  TextInput,
  FlatList,
  Image,
  TouchableWithoutFeedback,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useListStore } from '../state/useListStore';
import { useFamilyStore } from '../state/useFamilyStore';
import { syncManager } from '../sync/sync-manager';
import { useSyncStore, syncIndicatorStatus } from '../state/useSyncStore';
import { type GroceryList, BUILT_IN_CATEGORIES } from '../types';
import type { RootStackParamList } from '../navigation/deepLinks';
import { useShareInvite } from '../hooks/useShareInvite';
import { useThemeStore, useActiveTheme } from '../state/useThemeStore';
import SwipeableListCard from '../components/SwipeableListCard';
import ContextMenu from '../components/ContextMenu';
import DeleteConfirmationModal from '../components/DeleteConfirmationModal';
import UndoToast from '../components/UndoToast';
import GlassCard from '../components/GlassCard';
import SearchBar from '../components/SearchBar';
import BottomTabBar, { type TabName } from '../components/BottomTabBar';
import { themeColors } from '../components/groceryTheme';
import { Ionicons } from '@expo/vector-icons';
import { useGroceryStore } from '../state/useGroceryStore';
import BarcodeScannerScreen from '../components/BarcodeScannerScreen';
import { lookupProduct, submitNewProduct } from '../services/productLookup';
import { fetchDealsForFSA, type FlippDealRow } from '../services/dealMatcher';
import { getSettings } from '../config/settings';
import { ensureBarcodeLookupConsent } from '../services/barcodeConsent';
import { isTursoReady } from '../services/tursoClient';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export default function HomeScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();

  const themeMode = useThemeStore((s) => s.themeMode);
  const activeTheme = useActiveTheme();
  const isDark = activeTheme === 'dark';
  const theme = isDark ? themeColors.dark : themeColors.light;

  const lists = useListStore((s) => s.lists);
  const isLoading = useListStore((s) => s.isLoading);
  const loadLists = useListStore((s) => s.loadLists);
  const createList = useListStore((s) => s.createList);
  const updateList = useListStore((s) => s.updateList);
  const deleteList = useListStore((s) => s.deleteList);
  const restoreList = useListStore((s) => s.restoreList);

  const activeMemberId = useFamilyStore((s) => s.activeMemberId);
  const members = useFamilyStore((s) => s.members);

  const syncState = useSyncStore((s) => s.syncState);
  const syncError = useSyncStore((s) => s.error);
  const undecryptableLists = useSyncStore((s) => s.undecryptableLists);
  const recoveryPendingLists = useSyncStore((s) => s.recoveryPendingLists);
  const persistenceError = useSyncStore((s) => s.persistenceError);
  const storageRecoveryError = useSyncStore((s) => s.storageRecoveryError);

  const [copyingListId, setCopyingListId] = useState<string | null>(null);
  const copyingRef = useRef(false);

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<TabName>('home');

  // Delete flow state
  const [pendingDelete, setPendingDelete] = useState<GroceryList | null>(null);
  const [undoList, setUndoList] = useState<GroceryList | null>(null);
  const [flashMessage, setFlashMessage] = useState<string | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    list: GroceryList | null;
    position?: { x: number; y: number };
  }>({ visible: false, list: null });

  const { shareInvite } = useShareInvite();

  // Scanning & lookup states
  const [scanResult, setScanResult] = useState<{ barcode: string; product?: any } | null>(null);
  const [showListSelector, setShowListSelector] = useState(false);
  const [showNewProductForm, setShowNewProductForm] = useState(false);
  const [newProductName, setNewProductName] = useState('');
  const [newProductCategory, setNewProductCategory] = useState('other');
  const [newProductQty, setNewProductQty] = useState(1);
  const [newProductUnit, setNewProductUnit] = useState('pcs');
  const [lookupLoading, setLookupLoading] = useState(false);

  // Flyer deals states
  const [deals, setDeals] = useState<FlippDealRow[]>([]);
  const [dealsLoading, setDealsLoading] = useState(false);
  const [dealsError, setDealsError] = useState<string | null>(null);
  const [selectedMerchant, setSelectedMerchant] = useState<string | null>(null);
  const [dealsSearchQuery, setDealsSearchQuery] = useState('');
  const [pendingDealToAdd, setPendingDealToAdd] = useState<FlippDealRow | null>(null);

  const merchants = useMemo(() => {
    const set = new Set<string>();
    for (const d of deals) {
      if (d.merchant) set.add(d.merchant);
    }
    return Array.from(set).sort();
  }, [deals]);

  const filteredDeals = useMemo(() => {
    let list = deals;
    if (selectedMerchant) {
      list = list.filter((d) => d.merchant === selectedMerchant);
    }
    if (dealsSearchQuery.trim()) {
      const q = dealsSearchQuery.toLowerCase();
      list = list.filter((d) => d.name.toLowerCase().includes(q));
    }
    return list;
  }, [deals, selectedMerchant, dealsSearchQuery]);

  const abortedRef = useRef(false);

  const doLoadLists = useCallback(() => {
    abortedRef.current = false;
    setLoadError(null);

    const TIMEOUT_MS = 10_000;
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Loading timed out')), TIMEOUT_MS),
    );

    Promise.race([loadLists(), timeout])
      .then(() => {
        if (!abortedRef.current) {
          setLoaded(true);
          setLoadError(null);
        }
      })
      .catch((err: Error) => {
        if (!abortedRef.current) {
          setLoaded(true);
          setLoadError(err.message ?? 'Failed to load lists');
        }
      });
  }, [loadLists]);

  useEffect(() => {
    doLoadLists();
    return () => {
      abortedRef.current = true;
    };
  }, [doLoadLists]);

  // First-run recovery backup prompt. Shown until the user explicitly taps
  // "I've Stored It Safely" on RecoveryScreen — dismissing the screen or
  // backgrounding never sets the flag, so the banner re-surfaces every visit
  // (deliberately unlike the contributeConsentShown modal, whose dismiss
  // handlers suppress it forever).
  const [showRecoveryPrompt, setShowRecoveryPrompt] = useState(false);
  useEffect(() => {
    const refresh = async () => {
      try {
        if (getSettings().recoveryPhraseAcknowledged) {
          setShowRecoveryPrompt(false);
          return;
        }
        // Only prompt when there is actually a stored phrase to show.
        const { hasRecoveryPhrase } = await import('../identity/recovery');
        setShowRecoveryPrompt(await hasRecoveryPhrase());
      } catch {
        setShowRecoveryPrompt(false);
      }
    };
    refresh();
    return navigation.addListener('focus', refresh);
  }, [navigation]);

  const handleListPress = useCallback(
    (list: GroceryList) => {
      navigation.navigate('GroceryList', { listId: list.id });
    },
    [navigation],
  );

  const handleSharedRecoveryCopy = useCallback((list: GroceryList) => {
    if (copyingRef.current) return;
    Alert.alert('Create a new shared recovery copy?',
      `A new shared list will contain the saved version of “${list.name}” when you tap Create copy. The original list and its pending changes stay on this device with sharing paused. Deleted items stay deleted.`, [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Create copy', onPress: async () => {
          if (copyingRef.current) return;
          copyingRef.current = true;
          setCopyingListId(list.id);
          try {
            const copy = await syncManager.createSharedRecoveryCopy(list.id);
            await loadLists();
            if (copy.isDeleted) {
              Alert.alert('Existing recovery copy was deleted', 'The saved recovery copy stays deleted. The original list and its pending changes remain preserved on this device.');
              return;
            }
            Alert.alert('Shared recovery copy saved',
              `“${copy.name}” is ready to share when connected. The original remains saved on this device with sharing paused.`,
              [{text: 'Open copy', onPress: () => handleListPress(copy)}]);
          } catch (err) {
            Alert.alert('Recovery copy needs attention', err instanceof Error ? err.message : 'Could not save the copy. The original data is retained.');
          } finally { copyingRef.current = false; setCopyingListId(null); }
        }},
      ]);
  }, [loadLists, handleListPress]);

  // Name-on-create + rename share one small modal (Alert.prompt is iOS-only).
  const [nameModal, setNameModal] = useState<
    { mode: 'create'; value: string } | { mode: 'rename'; listId: string; value: string } | null
  >(null);

  const handleCreateList = useCallback(() => {
    setNameModal({ mode: 'create', value: '' });
  }, []);

  const handleRenameList = useCallback((list: GroceryList) => {
    setNameModal({ mode: 'rename', listId: list.id, value: list.name });
  }, []);

  const handleNameModalSubmit = useCallback(async () => {
    if (!nameModal) return;
    const name = nameModal.value.trim() || 'My Grocery List';
    try {
      if (nameModal.mode === 'create') {
        const firstMember = Object.values(members).find((m) => m.isActive);
        const familyId = firstMember?.familyId ?? 'default-family';
        const newList = await createList(name, familyId);
        setNameModal(null);
        navigation.navigate('GroceryList', { listId: newList.id });
      } else {
        await updateList(nameModal.listId, { name });
        setNameModal(null);
      }
    } catch (err) {
      Alert.alert(
        'Could not save',
        err instanceof Error ? err.message : 'Please try again.',
      );
    }
  }, [nameModal, members, createList, updateList, navigation]);

  // Delete handlers
  const handleDeleteInitiated = useCallback((list: GroceryList) => {
    setPendingDelete(list);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!pendingDelete) return;
    const deletedList = { ...pendingDelete };
    setUndoList(deletedList);
    await deleteList(pendingDelete.id);
    setPendingDelete(null);
  }, [pendingDelete, deleteList]);

  const handleDeleteCancel = useCallback(() => {
    setPendingDelete(null);
  }, []);

  const handleUndo = useCallback(async () => {
    if (!undoList) return;
    await restoreList(undoList);
    setUndoList(null);
  }, [undoList, restoreList]);

  const handleUndoDismiss = useCallback(() => {
    setUndoList(null);
  }, []);

  // Context menu handlers
  const handleLongPress = useCallback(
    (list: GroceryList, event: GestureResponderEvent) => {
      const { pageX, pageY } = event.nativeEvent;
      setContextMenu({
        visible: true,
        list,
        position: { x: pageX - 100, y: pageY - 60 },
      });
    },
    [],
  );

  const handleContextMenuClose = useCallback(() => {
    setContextMenu({ visible: false, list: null });
  }, []);

  const handleContextMenuDelete = useCallback(() => {
    if (contextMenu.list) {
      handleDeleteInitiated(contextMenu.list);
    }
  }, [contextMenu.list, handleDeleteInitiated]);

  // Sharing a list means inviting someone into the family (sync is
  // family-wide, not per-list). Generate a real, joinable invite — the same
  // payload the pairing/QR flow produces — instead of a bare list blob that
  // the join flow can't consume.
  const shareFamilyInvite = useCallback(async () => {
    try {
      const { createFamilyInviteLink, inviteTokenToUrl } = await import('../identity/invite-link');
      const { token, selfEnrollFailed } = await createFamilyInviteLink();
      if (selfEnrollFailed) {
        Alert.alert(
          'Heads up',
          "The invite link is ready, but this device couldn't reach the relay to enroll itself — your own edits may not sync until you retry with the relay online.",
        );
      }
      await shareInvite(inviteTokenToUrl(token));
    } catch (err) {
      Alert.alert(
        'Cannot Create Invite',
        err instanceof Error ? err.message : 'Failed to create invite link.',
      );
    }
  }, [shareInvite]);

  const handleContextMenuShare = useCallback(() => {
    shareFamilyInvite();
  }, [shareFamilyInvite]);

  const handleShare = useCallback(() => {
    shareFamilyInvite();
  }, [shareFamilyInvite]);

  const loadFlyerDeals = useCallback(async () => {
    setDealsLoading(true);
    setDealsError(null);
    try {
      const settings = getSettings();
      const fsa = settings.flippFsa;
      if (!fsa) {
        setDealsError('fsa_missing');
        setDealsLoading(false);
        return;
      }
      if (!settings.relayUrl) {
        setDealsError('relay_missing');
        setDealsLoading(false);
        return;
      }
      const fetched = await fetchDealsForFSA(fsa);
      setDeals(fetched);
    } catch (err) {
      setDealsError(err instanceof Error ? err.message : 'Failed to load deals');
    } finally {
      setDealsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'deals') {
      loadFlyerDeals();
    }
  }, [activeTab, loadFlyerDeals]);

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    setLookupLoading(true);
    try {
      const result = await lookupProduct(barcode);
      if (result.status === 'found') {
        setScanResult({ barcode, product: result.product });
        setShowListSelector(true);
      } else {
        setScanResult({ barcode });
        setNewProductName('');
        setNewProductCategory('other');
        setNewProductQty(1);
        setNewProductUnit('pcs');
        setShowNewProductForm(true);
      }
    } catch (err) {
      Alert.alert('Scan Error', err instanceof Error ? err.message : 'Failed to look up barcode');
      setActiveTab('home');
    } finally {
      setLookupLoading(false);
    }
  }, []);

  const handleAddProductToList = useCallback(async (listId: string) => {
    if (!scanResult) return;
    
    let name = '';
    let category = 'other';
    let qty = 1;
    let unit = 'pcs';
    let imageUrl = undefined;
    
    if (scanResult.product) {
      name = scanResult.product.productName;
      category = scanResult.product.category || 'other';
      imageUrl = scanResult.product.imageUrl;
      const qtyLabel = scanResult.product.quantityLabel || '';
      const numMatch = qtyLabel.match(/\d+/);
      const unitMatch = qtyLabel.match(/[a-zA-Z]+/);
      if (numMatch) qty = parseInt(numMatch[0], 10);
      if (unitMatch) unit = unitMatch[0];
    } else {
      name = newProductName.trim() || 'Scanned Item';
      category = newProductCategory;
      qty = newProductQty;
      unit = newProductUnit;
    }
    
    try {
      if (!scanResult.product && newProductName.trim()) {
        if (isTursoReady()) {
          try {
            await submitNewProduct({
              barcode: scanResult.barcode,
              rawName: newProductName,
              category,
              quantityLabel: `${qty} ${unit}`,
            });
          } catch (e) {
            console.warn('Contributing product failed:', e);
          }
        }
      }
      
      const list = lists[listId];
      if (!list) return;
      
      await useGroceryStore.getState().addItem({
        listId,
        familyId: list.familyId,
        name,
        quantity: qty,
        unit,
        category,
        isChecked: false,
        addedBy: activeMemberId || 'system',
        imageUrl,
        sortOrder: 0,
      });
      
      setFlashMessage(`Added "${name}" to "${list.name}"`);
      setShowListSelector(false);
      setShowNewProductForm(false);
      setScanResult(null);
      setActiveTab('home');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to add item');
    }
  }, [scanResult, newProductName, newProductCategory, newProductQty, newProductUnit, lists, activeMemberId]);

  const handleAddDealToList = useCallback(async (listId: string) => {
    if (!pendingDealToAdd) return;
    
    const list = lists[listId];
    if (!list) return;
    
    let category = 'other';
    const nameLower = pendingDealToAdd.name.toLowerCase();
    for (const cat of BUILT_IN_CATEGORIES) {
      if (nameLower.includes(cat.toLowerCase())) {
        category = cat;
        break;
      }
    }
    
    try {
      await useGroceryStore.getState().addItem({
        listId,
        familyId: list.familyId,
        name: pendingDealToAdd.name,
        quantity: 1,
        unit: 'pcs',
        category,
        isChecked: false,
        addedBy: activeMemberId || 'system',
        imageUrl: pendingDealToAdd.image_url ?? undefined,
        sortOrder: 0,
      });
      
      setFlashMessage(`Added "${pendingDealToAdd.name}" to "${list.name}"`);
      setPendingDealToAdd(null);
      setShowListSelector(false);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to add deal');
    }
  }, [pendingDealToAdd, lists, activeMemberId]);

  const handleListSelect = useCallback(async (listId: string) => {
    if (pendingDealToAdd) {
      await handleAddDealToList(listId);
    } else if (scanResult) {
      await handleAddProductToList(listId);
    }
  }, [pendingDealToAdd, scanResult, handleAddDealToList, handleAddProductToList]);

  const handleTabPress = useCallback((tab: TabName) => {
    if (tab === 'account') {
      navigation.navigate('Settings');
      setActiveTab('home');
    } else if (tab === 'scan') {
      // Barcode lookups send the scanned barcode to Open Food Facts — get
      // consent (persisted as barcodeScanningEnabled) before opening the camera.
      void ensureBarcodeLookupConsent().then((granted) => {
        if (!granted) return;
        setActiveTab('scan');
        setScanResult(null);
        setPendingDealToAdd(null);
        setShowListSelector(false);
        setShowNewProductForm(false);
      });
    } else {
      setActiveTab(tab);
      // Reset scan & deals pending state when switching tabs
      setScanResult(null);
      setPendingDealToAdd(null);
      setShowListSelector(false);
      setShowNewProductForm(false);
    }
  }, [navigation]);

  const activeLists = Object.values(lists).filter(
    (l) => !l.isDeleted,
  );

  // Filter lists by search
  const filteredLists = searchQuery.trim()
    ? activeLists.filter((l) =>
        l.name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : activeLists;

  // Derived by the SAME function as SyncIndicator. This screen used to carry
  // its own copy of the ladder, so it printed a green "Connected" for a device
  // that could not decrypt a single message — and since Home is the landing
  // route (App.tsx) and SyncIndicator lives only in GroceryListScreen's header,
  // the reassuring copy was the one nearly every user saw. Two ladders over one
  // store is how a status display ends up contradicting itself.
  const syncStatus = syncIndicatorStatus({ syncState, error: syncError, undecryptableLists, recoveryPendingLists, persistenceError, storageRecoveryError });
  const syncDotColor =
    syncState === 'syncing' && syncStatus.color !== '#f44336'
      ? theme.accent
      : syncStatus.color === '#10B981'
        ? theme.primary
        : syncStatus.color;

  const renderListsView = () => {
    if (!loaded || isLoading) {
      return (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.secondaryText }]}>Loading lists...</Text>
        </View>
      );
    }
    
    if (loadError) {
      return (
        <View style={styles.emptyContainer}>
          <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
          <Text style={[styles.emptyTitle, { color: '#EF4444', marginTop: 12 }]}>Something went wrong</Text>
          <Text style={[styles.emptySubtitle, { color: theme.secondaryText }]}>
            {loadError}
          </Text>
          <TouchableOpacity style={[styles.createBtn, { backgroundColor: theme.primary }]} onPress={doLoadLists}>
            <Text style={styles.createBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    
    if (filteredLists.length === 0) {
      return (
        <View style={styles.emptyContainer}>
          <Ionicons name="cart-outline" size={48} color={theme.secondaryText} />
          <Text style={[styles.emptyTitle, { color: theme.text, marginTop: 12 }]}>
            {searchQuery ? 'No matching lists' : 'No grocery lists yet'}
          </Text>
          <Text style={[styles.emptySubtitle, { color: theme.secondaryText }]}>
            {searchQuery ? 'Try a different search' : 'Create your first list to get started'}
          </Text>
          {!searchQuery && (
            <TouchableOpacity style={[styles.createBtn, { backgroundColor: theme.primary }]} onPress={handleCreateList}>
              <Ionicons name="add" size={18} color="#fff" style={{ marginRight: 6 }} />
              <Text style={styles.createBtnText}>Create List</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    }

    return (
      <ScrollView
        style={styles.listScroll}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {filteredLists.map((list) => (
          <SwipeableListCard
            key={list.id}
            list={list}
            onPress={() => handleListPress(list)}
            onDelete={() => handleDeleteInitiated(list)}
            onShare={() => handleShare()}
            onLongPress={(event) => handleLongPress(list, event)}
          />
        ))}

        <TouchableOpacity
          style={[styles.createListCard, {
            borderColor: isDark ? 'rgba(0, 230, 118, 0.15)' : 'rgba(124, 179, 66, 0.3)',
            backgroundColor: isDark ? 'rgba(0, 230, 118, 0.05)' : 'rgba(124, 179, 66, 0.06)',
          }]}
          onPress={handleCreateList}
          activeOpacity={0.7}
        >
          <Ionicons name="add-circle-outline" size={24} color={theme.primary} />
          <Text style={[styles.createListText, { color: theme.primary }]}>New List</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  };

  const renderDealsFeed = () => {
    const settings = getSettings();
    const fsa = (settings as any).flippFsa;

    const renderDealsHeader = () => (
      <View style={styles.dealsHeaderContainer}>
        <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20 }}>
          <Text style={[styles.title, { color: theme.text }]}>Local Deals</Text>
          {fsa && (
            <Text style={{ fontSize: 13, color: theme.secondaryText, marginTop: 2 }}>
              Weekly flyer offers near you (FSA: <Text style={{ color: theme.primary, fontWeight: 'bold' }}>{fsa}</Text>)
            </Text>
          )}
        </View>

        <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
          <View style={[styles.dealsSearchBox, { backgroundColor: theme.inputBg }]}>
            <Ionicons name="search-outline" size={18} color={theme.secondaryText} style={{ marginRight: 8 }} />
            <TextInput
              style={[styles.dealsSearchInput, { color: theme.text }]}
              value={dealsSearchQuery}
              onChangeText={setDealsSearchQuery}
              placeholder="Search flyer deals..."
              placeholderTextColor={theme.secondaryText}
            />
            {dealsSearchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setDealsSearchQuery('')}>
                <Ionicons name="close-circle" size={18} color={theme.secondaryText} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {merchants.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.storePillsContainer}
          >
            <TouchableOpacity
              onPress={() => setSelectedMerchant(null)}
              style={[
                styles.storePill,
                {
                  backgroundColor: !selectedMerchant ? theme.primary : theme.inputBg,
                },
              ]}
            >
              <Text style={{ color: !selectedMerchant ? '#fff' : theme.text, fontWeight: !selectedMerchant ? '600' : '400' }}>
                All Stores
              </Text>
            </TouchableOpacity>

            {merchants.map((m) => {
              const active = selectedMerchant === m;
              return (
                <TouchableOpacity
                  key={m}
                  onPress={() => setSelectedMerchant(m)}
                  style={[
                    styles.storePill,
                    {
                      backgroundColor: active ? theme.primary : theme.inputBg,
                    },
                  ]}
                >
                  <Text style={{ color: active ? '#fff' : theme.text, fontWeight: active ? '600' : '400' }}>
                    {m}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </View>
    );

    if (dealsLoading) {
      return (
        <View style={{ flex: 1 }}>
          {renderDealsHeader()}
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color={theme.primary} />
            <Text style={[styles.loadingText, { color: theme.secondaryText }]}>Fetching flyer deals...</Text>
          </View>
        </View>
      );
    }

    if (dealsError === 'fsa_missing' || dealsError === 'relay_missing' || (!fsa && !dealsError)) {
      return (
        <View style={{ flex: 1 }}>
          {renderDealsHeader()}
          <View style={styles.emptyContainer}>
            <Ionicons name="pricetag-outline" size={48} color={theme.secondaryText} />
            <Text style={[styles.emptyTitle, { color: theme.text, marginTop: 12 }]}>
              Flyers Unconfigured
            </Text>
            <Text style={[styles.emptySubtitle, { color: theme.secondaryText, textAlign: 'center', marginBottom: 20 }]}>
              {!fsa
                ? 'Please configure your FSA (postal code prefix) in settings to see local grocery flyers.'
                : 'Set up your relay in Settings to see this week\'s flyer deals.'}
            </Text>
            <TouchableOpacity
              style={[styles.createBtn, { backgroundColor: theme.primary }]}
              onPress={() => navigation.navigate('Settings')}
            >
              <Text style={styles.createBtnText}>Go to Settings</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    if (dealsError) {
      return (
        <View style={{ flex: 1 }}>
          {renderDealsHeader()}
          <View style={styles.emptyContainer}>
            <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
            <Text style={[styles.emptyTitle, { color: '#EF4444', marginTop: 12 }]}>Failed to load deals</Text>
            <Text style={[styles.emptySubtitle, { color: theme.secondaryText }]}>{dealsError}</Text>
            <TouchableOpacity style={[styles.createBtn, { backgroundColor: theme.primary }]} onPress={loadFlyerDeals}>
              <Text style={styles.createBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    return (
      <View style={{ flex: 1 }}>
        <FlatList
          data={filteredDeals}
          keyExtractor={(item, index) => `${item.merchant}-${item.name}-${index}`}
          ListHeaderComponent={renderDealsHeader}
          contentContainerStyle={{ paddingBottom: 20 }}
          renderItem={({ item }) => (
            <View style={[styles.dealCard, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
              {item.image_url ? (
                <Image source={{ uri: item.image_url }} style={styles.dealImage} resizeMode="contain" />
              ) : (
                <View style={[styles.dealPlaceholder, { backgroundColor: theme.inputBg }]}>
                  <Ionicons name="fast-food-outline" size={24} color={theme.secondaryText} />
                </View>
              )}
              <View style={styles.dealInfo}>
                <View style={styles.dealMerchantBadgeContainer}>
                  <Text style={[styles.dealMerchantBadge, { backgroundColor: theme.primary + '1a', color: theme.primary }]}>
                    {item.merchant}
                  </Text>
                </View>
                <Text style={[styles.dealName, { color: theme.text }]} numberOfLines={2}>
                  {item.name}
                </Text>
                <Text style={[styles.dealPrice, { color: theme.accent }]}>
                  {item.price}
                </Text>
                <Text style={{ fontSize: 10, color: theme.secondaryText, marginTop: 4 }}>
                  Ends {new Date(item.valid_to).toLocaleDateString()}
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.addDealBtn, { backgroundColor: theme.primary }]}
                onPress={() => {
                  setPendingDealToAdd(item);
                  setShowListSelector(true);
                }}
                activeOpacity={0.7}
              >
                <Ionicons name="add" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
          )}
          ListEmptyComponent={
            <View style={[styles.emptyContainer, { marginTop: 40 }]}>
              <Ionicons name="search-outline" size={48} color={theme.secondaryText} />
              <Text style={[styles.emptyTitle, { color: theme.text, marginTop: 12 }]}>No deals found</Text>
              <Text style={[styles.emptySubtitle, { color: theme.secondaryText }]}>
                Try searching for a different item or brand.
              </Text>
            </View>
          }
        />
      </View>
    );
  };

  const renderBody = () => {
    switch (activeTab) {
      case 'scan':
        return (
          <View style={styles.tabBodyContainer}>
            <BarcodeScannerScreen
              onScan={handleBarcodeScanned}
              onCancel={() => setActiveTab('home')}
            />
            {lookupLoading && (
              <View style={StyleSheet.absoluteFill}>
                <View style={[styles.loadingOverlay, { backgroundColor: 'rgba(0,0,0,0.7)' }]}>
                  <ActivityIndicator size="large" color={theme.primary} />
                  <Text style={{ color: '#fff', marginTop: 12, fontSize: 16 }}>Looking up barcode...</Text>
                </View>
              </View>
            )}
          </View>
        );
      case 'deals':
        return renderDealsFeed();
      default:
        return renderListsView();
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {(activeTab === 'home' || activeTab === 'lists') && (
        <>
          {/* Header */}
          <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
            <Text style={[styles.title, { color: theme.text }]}>PantryRun</Text>
            <View style={styles.headerRight}>
              <TouchableOpacity
                onPress={() => navigation.navigate('Pairing')}
                style={[styles.iconBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#F5F0E8' }]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Pair a device or join a family"
              >
                <Ionicons name="people-outline" size={20} color={theme.text} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => navigation.navigate('Settings')}
                style={[styles.iconBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#F5F0E8' }]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Settings"
              >
                <Ionicons name="settings-outline" size={20} color={theme.text} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Sync indicator — tappable when not set up, to reach Pairing */}
          {syncStatus.label === 'Local only' ? (
            <TouchableOpacity
              style={styles.syncBar}
              onPress={() => navigation.navigate('Pairing')}
              accessibilityRole="button"
              accessibilityLabel="Local only. Tap to set up family sharing."
            >
              <View style={[styles.syncDot, { backgroundColor: syncDotColor }]} />
              <Text style={[styles.syncText, { color: theme.secondaryText }]}>
                Local only — tap to set up sharing
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.syncBar}>
              <View style={[styles.syncDot, { backgroundColor: syncDotColor }]} />
              <Text style={[styles.syncText, { color: theme.secondaryText }]}>
                {syncStatus.label === 'List recovery needed — sharing paused' ? 'Some lists need recovery' : syncStatus.label}
              </Text>
            </View>
          )}

          {recoveryPendingLists.map(id => lists[id]).filter((list): list is GroceryList => !!list && !list.isDeleted).map(list => (
            <View key={`recovery-${list.id}`} style={[styles.recoveryBanner, {backgroundColor: isDark ? 'rgba(255, 152, 0, 0.12)' : '#FFF8E1'}]}>
              <View style={styles.recoveryBannerTextWrap}>
                <Text style={[styles.recoveryBannerTitle, {color: theme.text}]}>{list.name}</Text>
                <Text style={[styles.syncText, {color: theme.secondaryText}]}>Saved on this device — sharing paused</Text>
                <TouchableOpacity onPress={() => handleSharedRecoveryCopy(list)} disabled={!!copyingListId}
                  accessibilityRole="button" accessibilityLabel={`Create a new shared recovery copy of ${list.name}`}>
                  <Text style={[styles.recoveryBannerTitle, {color: '#C05621', marginTop: 8}]}>
                    {copyingListId === list.id ? 'Saving recovery copy…' : 'Create a new shared recovery copy'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}

          {/* First-run recovery backup prompt — persists until explicitly
              acknowledged on RecoveryScreen; back/dismiss brings it back. */}
          {showRecoveryPrompt && (
            <TouchableOpacity
              style={[
                styles.recoveryBanner,
                { backgroundColor: isDark ? 'rgba(255, 152, 0, 0.12)' : '#FFF8E1' },
              ]}
              onPress={() => navigation.navigate('Recovery', { mode: 'show' })}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Back up your recovery phrase. Without it, losing this phone means losing your lists."
            >
              <Text style={styles.recoveryBannerIcon}>🔐</Text>
              <View style={styles.recoveryBannerTextWrap}>
                <Text style={[styles.recoveryBannerTitle, { color: theme.text }]}>
                  Back up your recovery phrase
                </Text>
                <Text style={[styles.recoveryBannerSubtitle, { color: theme.secondaryText }]}>
                  Your lists are encrypted. Without the phrase, losing this
                  phone means losing them — tap to view and save it.
                </Text>
              </View>
            </TouchableOpacity>
          )}

          {/* Search bar */}
          <SearchBar value={searchQuery} onChangeText={setSearchQuery} placeholder="Search groceries..." />
        </>
      )}

      {/* Main Body */}
      {renderBody()}

      {/* Bottom Tab Bar */}
      <BottomTabBar activeTab={activeTab} onTabPress={handleTabPress} />

      {/* Context Menu (long-press) */}
      <ContextMenu
        visible={contextMenu.visible}
        listName={contextMenu.list?.name ?? ''}
        onDelete={handleContextMenuDelete}
        onShare={handleContextMenuShare}
        onRename={contextMenu.list ? () => handleRenameList(contextMenu.list!) : undefined}
        onClose={handleContextMenuClose}
        theme={theme}
        position={contextMenu.position}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmationModal
        visible={!!pendingDelete}
        listName={pendingDelete?.name ?? ''}
        onCancel={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        theme={theme}
      />

      {/* Undo Toast */}
      {flashMessage && !undoList && (
        <UndoToast
          message={flashMessage}
          duration={2500}
          onDismiss={() => setFlashMessage(null)}
        />
      )}

      {undoList && (
        <UndoToast
          message={`"${undoList.name}" deleted`}
          onUndo={handleUndo}
          onDismiss={handleUndoDismiss}
        />
      )}

      {/* Name / Rename list modal */}
      <Modal
        visible={nameModal !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setNameModal(null)}
        statusBarTranslucent
      >
        <TouchableWithoutFeedback onPress={() => setNameModal(null)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={[styles.listSelectorDialog, { backgroundColor: theme.cardBg }]}>
                <Text style={[styles.listSelectorTitle, { color: theme.text }]}>
                  {nameModal?.mode === 'rename' ? 'Rename list' : 'Name your list'}
                </Text>
                <TextInput
                  style={[styles.nameInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bg }]}
                  value={nameModal?.value ?? ''}
                  onChangeText={(t) =>
                    setNameModal((m) => (m ? { ...m, value: t } : m))
                  }
                  placeholder="e.g. Weekly groceries"
                  placeholderTextColor={theme.secondaryText}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={handleNameModalSubmit}
                  maxLength={60}
                  accessibilityLabel="List name"
                />
                <View style={styles.nameModalActions}>
                  <TouchableOpacity
                    style={styles.nameModalBtn}
                    onPress={() => setNameModal(null)}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel"
                  >
                    <Text style={{ color: theme.secondaryText, fontSize: 16, fontWeight: '600' }}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.nameModalBtn, styles.nameModalBtnPrimary, { backgroundColor: theme.primary }]}
                    onPress={handleNameModalSubmit}
                    accessibilityRole="button"
                    accessibilityLabel={nameModal?.mode === 'rename' ? 'Save name' : 'Create list'}
                  >
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                      {nameModal?.mode === 'rename' ? 'Save' : 'Create'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* List Selector Modal */}
      <Modal
        visible={showListSelector}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setShowListSelector(false);
          setPendingDealToAdd(null);
        }}
        statusBarTranslucent
      >
        <TouchableWithoutFeedback onPress={() => {
          setShowListSelector(false);
          setPendingDealToAdd(null);
        }}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={[styles.listSelectorDialog, { backgroundColor: theme.cardBg }]}>
                <Text style={[styles.listSelectorTitle, { color: theme.text }]}>
                  Add to List
                </Text>
                <Text style={[styles.listSelectorSubtitle, { color: theme.secondaryText }]}>
                  Choose which grocery list to add this item to:
                </Text>
                
                {activeLists.length === 0 ? (
                  <View style={{ padding: 20, alignItems: 'center' }}>
                    <Text style={{ color: theme.secondaryText, marginBottom: 12 }}>No grocery lists found.</Text>
                    <TouchableOpacity
                      style={[styles.createBtn, { backgroundColor: theme.primary }]}
                      onPress={async () => {
                        setShowListSelector(false);
                        await handleCreateList();
                      }}
                    >
                      <Text style={styles.createBtnText}>Create a List</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <ScrollView style={{ maxHeight: 200, marginVertical: 10 }}>
                    {activeLists.map((list) => (
                      <TouchableOpacity
                        key={list.id}
                        style={[styles.listSelectOption, { borderBottomColor: theme.border }]}
                        onPress={() => handleListSelect(list.id)}
                      >
                        <Ionicons name="list" size={20} color={theme.primary} style={{ marginRight: 10 }} />
                        <Text style={{ fontSize: 16, color: theme.text, fontWeight: '500' }}>
                          {list.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}

                <TouchableOpacity
                  style={[styles.closeModalBtn, { borderTopColor: theme.border }]}
                  onPress={() => {
                    setShowListSelector(false);
                    setPendingDealToAdd(null);
                  }}
                >
                  <Text style={{ color: theme.secondaryText, fontSize: 16, fontWeight: '600' }}>
                    Cancel
                  </Text>
                </TouchableOpacity>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* New Product Modal (Barcode not found fallback) */}
      <Modal
        visible={showNewProductForm}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setShowNewProductForm(false);
          setScanResult(null);
          setActiveTab('home');
        }}
        statusBarTranslucent
      >
        <TouchableWithoutFeedback onPress={() => {
          setShowNewProductForm(false);
          setScanResult(null);
          setActiveTab('home');
        }}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={[styles.newProductDialog, { backgroundColor: theme.cardBg }]}>
                <Text style={[styles.newProductTitle, { color: theme.text }]}>
                  Product Not Found
                </Text>
                <Text style={{ fontSize: 12, color: theme.secondaryText, textAlign: 'center', marginBottom: 16, paddingHorizontal: 20 }}>
                  Barcode {scanResult?.barcode} is not in our system. Enter details manually to add and contribute it:
                </Text>

                <View style={{ gap: 12, paddingHorizontal: 20, marginBottom: 20 }}>
                  <View>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: theme.secondaryText, marginBottom: 4 }}>
                      Item Name *
                    </Text>
                    <TextInput
                      style={[styles.modalInput, { backgroundColor: theme.inputBg, color: theme.text }]}
                      value={newProductName}
                      onChangeText={setNewProductName}
                      placeholder="e.g. Organic Skim Milk"
                      placeholderTextColor={theme.secondaryText}
                    />
                  </View>

                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: theme.secondaryText, marginBottom: 4 }}>
                        Qty
                      </Text>
                      <TextInput
                        style={[styles.modalInput, { backgroundColor: theme.inputBg, color: theme.text, textAlign: 'center' }]}
                        value={String(newProductQty)}
                        onChangeText={(v) => setNewProductQty(parseInt(v.replace(/\D/g, '')) || 1)}
                        keyboardType="number-pad"
                      />
                    </View>
                    <View style={{ flex: 2 }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: theme.secondaryText, marginBottom: 4 }}>
                        Unit
                      </Text>
                      <TextInput
                        style={[styles.modalInput, { backgroundColor: theme.inputBg, color: theme.text }]}
                        value={newProductUnit}
                        onChangeText={setNewProductUnit}
                        placeholder="pcs"
                        placeholderTextColor={theme.secondaryText}
                      />
                    </View>
                  </View>

                  <View>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: theme.secondaryText, marginBottom: 4 }}>
                      Category
                    </Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 2 }}>
                      {BUILT_IN_CATEGORIES.map((cat) => {
                        const active = newProductCategory === cat;
                        return (
                          <TouchableOpacity
                            key={cat}
                            onPress={() => setNewProductCategory(cat)}
                            style={[
                              styles.categoryChip,
                              {
                                backgroundColor: active ? theme.primary : theme.inputBg,
                              },
                            ]}
                          >
                            <Text style={{ color: active ? '#fff' : theme.text, fontSize: 12, fontWeight: active ? '600' : '400' }}>
                              {cat}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                </View>

                <View style={[styles.newProductButtonRow, { borderTopColor: theme.border }]}>
                  <TouchableOpacity
                    style={styles.newProductBtn}
                    onPress={() => {
                      setShowNewProductForm(false);
                      setScanResult(null);
                      setActiveTab('home');
                    }}
                  >
                    <Text style={{ color: theme.secondaryText, fontSize: 16 }}>Cancel</Text>
                  </TouchableOpacity>
                  <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: theme.border }} />
                  <TouchableOpacity
                    style={[styles.newProductBtn, { backgroundColor: theme.primary + '10' }]}
                    onPress={() => {
                      if (!newProductName.trim()) {
                        Alert.alert('Required', 'Please enter a product name');
                        return;
                      }
                      setShowListSelector(true);
                    }}
                  >
                    <Text style={{ color: theme.primary, fontSize: 16, fontWeight: '600' }}>Next</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    fontFamily: Platform.OS === 'ios' ? 'Outfit-Bold' : 'sans-serif-medium',
    letterSpacing: -0.5,
  },
  headerRight: {
    flexDirection: 'row',
    gap: 10,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  syncBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 4,
    gap: 6,
  },
  syncDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  syncText: {
    fontSize: 11,
    fontWeight: '500',
  },
  recoveryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FF9800',
    gap: 10,
  },
  recoveryBannerIcon: {
    fontSize: 20,
  },
  recoveryBannerTextWrap: {
    flex: 1,
  },
  recoveryBannerTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  recoveryBannerSubtitle: {
    fontSize: 12,
    lineHeight: 16,
  },
  loadingRow: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 8,
  },
  loadingText: {
    fontSize: 14,
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
    marginBottom: 20,
  },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
  },
  createBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  listScroll: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    gap: 10,
    paddingBottom: 16,
  },
  createListCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    gap: 8,
  },
  createListText: {
    fontSize: 15,
    fontWeight: '600',
  },
  tabBodyContainer: {
    flex: 1,
  },
  loadingOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dealsHeaderContainer: {
    paddingBottom: 8,
  },
  dealsSearchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 12,
    height: 44,
  },
  dealsSearchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 8,
  },
  storePillsContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  storePill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
  },
  dealCard: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginVertical: 6,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
  },
  dealImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
  },
  dealPlaceholder: {
    width: 60,
    height: 60,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dealInfo: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
  },
  dealMerchantBadgeContainer: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  dealMerchantBadge: {
    fontSize: 10,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  dealName: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  dealPrice: {
    fontSize: 15,
    fontWeight: 'bold',
    marginTop: 4,
  },
  addDealBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listSelectorDialog: {
    width: '85%',
    borderRadius: 20,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 15,
  },
  listSelectorTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 6,
  },
  nameInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginTop: 14,
    marginBottom: 16,
  },
  nameModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  nameModalBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
  },
  nameModalBtnPrimary: {
    minWidth: 96,
    alignItems: 'center',
  },
  listSelectorSubtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  listSelectOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  closeModalBtn: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 16,
    alignItems: 'center',
    marginTop: 10,
  },
  newProductDialog: {
    width: '85%',
    borderRadius: 20,
    paddingVertical: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 15,
  },
  newProductTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 6,
  },
  modalInput: {
    height: 44,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  categoryChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  newProductButtonRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 10,
  },
  newProductBtn: {
    flex: 1,
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
