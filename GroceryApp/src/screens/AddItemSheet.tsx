/**
 * AddItemSheet — quick-add bottom sheet for grocery items.
 *
 * Provides:
 *  - Quick-add buttons for common items (categorized)
 *  - Custom item input (name + quantity + unit)
 *  - Voice input: on iOS uses Alert.prompt, on Android uses a text modal
 *  - Parsed voice text pre-fills the name/quantity/unit fields
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Modal,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { BUILT_IN_CATEGORIES } from '../types';
import { useGroceryStore } from '../state/useGroceryStore';
import { useFamilyStore } from '../state/useFamilyStore';
import { parseVoiceText } from '../voice/nlp';
import type { ParsedItem } from '../voice/types';
import { useActiveTheme } from '../state/useThemeStore';
import BarcodeScannerScreen from '../components/BarcodeScannerScreen';
import { lookupProduct, submitNewProduct } from '../services/productLookup';
import { ensureBarcodeLookupConsent } from '../services/barcodeConsent';
import type { ProductInfo, ScanResult } from '../types/product';

// ─── Props ──────────────────────────────────────────────────────────────────

interface AddItemSheetProps {
  visible: boolean;
  listId: string;
  onClose: () => void;
  onItemAdded?: () => void;
  /** Open the Google Keep import sheet */
  onImportList?: () => void;
}

// ─── Common Quick-Add Items ──────────────────────────────────────────────────

interface QuickItem {
  name: string;
  category: string;
  unit: string;
  quantity: number;
}

const QUICK_ITEMS: Record<string, QuickItem[]> = {
  produce: [
    { name: 'Apples', category: 'produce', unit: 'pcs', quantity: 6 },
    { name: 'Bananas', category: 'produce', unit: 'bunch', quantity: 1 },
    { name: 'Lettuce', category: 'produce', unit: 'pcs', quantity: 1 },
    { name: 'Tomatoes', category: 'produce', unit: 'pcs', quantity: 4 },
    { name: 'Carrots', category: 'produce', unit: 'bag', quantity: 1 },
    { name: 'Potatoes', category: 'produce', unit: 'lb', quantity: 5 },
    { name: 'Onions', category: 'produce', unit: 'pcs', quantity: 3 },
    { name: 'Avocados', category: 'produce', unit: 'pcs', quantity: 2 },
  ],
  dairy: [
    { name: 'Milk', category: 'dairy', unit: 'L', quantity: 1 },
    { name: 'Eggs', category: 'dairy', unit: 'pcs', quantity: 12 },
    { name: 'Butter', category: 'dairy', unit: 'lb', quantity: 1 },
    { name: 'Cheese', category: 'dairy', unit: 'oz', quantity: 8 },
    { name: 'Yogurt', category: 'dairy', unit: 'pcs', quantity: 4 },
    { name: 'Cream', category: 'dairy', unit: 'ml', quantity: 250 },
  ],
  meat: [
    { name: 'Chicken Breast', category: 'meat', unit: 'lb', quantity: 2 },
    { name: 'Ground Beef', category: 'meat', unit: 'lb', quantity: 1 },
    { name: 'Bacon', category: 'meat', unit: 'oz', quantity: 12 },
    { name: 'Salmon', category: 'meat', unit: 'lb', quantity: 1 },
    { name: 'Ground Turkey', category: 'meat', unit: 'lb', quantity: 1 },
  ],
  bakery: [
    { name: 'Bread', category: 'bakery', unit: 'pcs', quantity: 1 },
    { name: 'Bagels', category: 'bakery', unit: 'pcs', quantity: 4 },
    { name: 'Croissants', category: 'bakery', unit: 'pcs', quantity: 2 },
    { name: 'Tortillas', category: 'bakery', unit: 'pcs', quantity: 8 },
  ],
  frozen: [
    { name: 'Frozen Pizza', category: 'frozen', unit: 'pcs', quantity: 1 },
    { name: 'Ice Cream', category: 'frozen', unit: 'pcs', quantity: 1 },
    { name: 'Frozen Veggies', category: 'frozen', unit: 'bag', quantity: 2 },
    { name: 'Frozen Fruit', category: 'frozen', unit: 'bag', quantity: 1 },
  ],
  pantry: [
    { name: 'Rice', category: 'pantry', unit: 'lb', quantity: 2 },
    { name: 'Pasta', category: 'pantry', unit: 'oz', quantity: 16 },
    { name: 'Olive Oil', category: 'pantry', unit: 'ml', quantity: 500 },
    { name: 'Salt', category: 'pantry', unit: 'oz', quantity: 16 },
    { name: 'Pepper', category: 'pantry', unit: 'oz', quantity: 4 },
    { name: 'Flour', category: 'pantry', unit: 'lb', quantity: 5 },
    { name: 'Sugar', category: 'pantry', unit: 'lb', quantity: 2 },
  ],
  beverages: [
    { name: 'Water', category: 'beverages', unit: 'L', quantity: 6 },
    { name: 'Orange Juice', category: 'beverages', unit: 'L', quantity: 1 },
    { name: 'Coffee', category: 'beverages', unit: 'oz', quantity: 12 },
    { name: 'Tea', category: 'beverages', unit: 'pcs', quantity: 20 },
  ],
  other: [
    { name: 'Paper Towels', category: 'other', unit: 'pcs', quantity: 1 },
    { name: 'Dish Soap', category: 'other', unit: 'pcs', quantity: 1 },
    { name: 'Trash Bags', category: 'other', unit: 'pcs', quantity: 1 },
  ],
};

// ─── Category Tabs ──────────────────────────────────────────────────────────

const CATEGORY_TABS = [...BUILT_IN_CATEGORIES];

import { themeColors } from '../components/groceryTheme';

// ─── Main Component ─────────────────────────────────────────────────────────

export default function AddItemSheet({
  visible,
  listId,
  onClose,
  onItemAdded,
  onImportList,
}: AddItemSheetProps) {
  // Store
  const addItem = useGroceryStore((s) => s.addItem);
  const items = useGroceryStore((s) => s.items);
  const activeMemberId = useFamilyStore((s) => s.activeMemberId);
  const familyMembers = useFamilyStore((s) => s.members);

  const activeTheme = useActiveTheme();
  const theme = themeColors[activeTheme];

  // Local state
  const [activeTab, setActiveTab] = useState('produce');
  const [customName, setCustomName] = useState('');
  const [customQty, setCustomQty] = useState('1');
  const [customUnit, setCustomUnit] = useState('pcs');
  const [adding, setAdding] = useState(false);

  // Barcode scanner state
  const [scanMode, setScanMode] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ barcode: string; product?: ProductInfo } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [showNewProductForm, setShowNewProductForm] = useState(false);
  const [newProductName, setNewProductName] = useState('');
  const [pendingImageUrl, setPendingImageUrl] = useState<string | undefined>();

  // Voice input state
  const [voiceModalVisible, setVoiceModalVisible] = useState(false);
  const [voiceText, setVoiceText] = useState('');
  const [voiceParsed, setVoiceParsed] = useState<ParsedItem | null>(null);
  const [voiceProcessing, setVoiceProcessing] = useState(false);

  // Reset form when sheet opens
  const resetForm = useCallback(() => {
    setCustomName('');
    setCustomQty('1');
    setCustomUnit('pcs');
    setActiveTab('produce');
    setAdding(false);
    setVoiceText('');
    setVoiceParsed(null);
    setVoiceModalVisible(false);
    setVoiceProcessing(false);
    // Reset scanner state
    setScanMode(false);
    setScanning(false);
    setScanResult(null);
    setScanError(null);
    setShowNewProductForm(false);
    setNewProductName('');
    setPendingImageUrl(undefined);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  // Add an item
  const handleAddItem = useCallback(
    async (name: string, category: string, unit: string, quantity: number, imageUrl?: string) => {
      setAdding(true);
      try {
        // Find familyId from first existing item or member
        const listItems = Object.values(items).filter(
          (i) => i.listId === listId,
        );
        const familyId =
          listItems.length > 0
            ? listItems[0].familyId
            : Object.values(familyMembers).length > 0
              ? Object.values(familyMembers)[0].familyId
              : '';

        const maxSort =
          listItems.length > 0
            ? Math.max(...listItems.map((i) => i.sortOrder))
            : 0;

        await addItem({
          listId,
          familyId,
          name,
          quantity,
          unit,
          category,
          isChecked: false,
          addedBy: activeMemberId ?? 'unknown',
          imageUrl,
          sortOrder: maxSort + 1,
        });

        resetForm();
        onItemAdded?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add item';
        Alert.alert('Error', message);
      } finally {
        setAdding(false);
      }
    },
    [addItem, items, listId, activeMemberId, familyMembers, resetForm, onItemAdded],
  );

  // Handle custom item add
  const handleAddCustom = useCallback(() => {
    if (!customName.trim()) return;
    const qty = parseInt(customQty, 10) || 1;
    handleAddItem(customName.trim(), activeTab, customUnit, qty, pendingImageUrl);
  }, [customName, customQty, activeTab, customUnit, handleAddItem, pendingImageUrl]);

  // ── Voice Input Handlers ───────────────────────────────────────────────

  /**
   * Process raw voice text through the NLP parser and pre-fill the form.
   */
  const processVoiceText = useCallback(
    (rawText: string) => {
      setVoiceProcessing(true);
      try {
        const parsed = parseVoiceText(rawText);
        setVoiceParsed(parsed);

        if (parsed.name) {
          setCustomName(parsed.name);
          setCustomQty(String(parsed.quantity));
          setCustomUnit(parsed.unit);
        }

        setVoiceModalVisible(false);
      } catch (err) {
        Alert.alert(
          'Could not parse',
          'Please try typing the item name directly.',
        );
      } finally {
        setVoiceProcessing(false);
      }
    },
    [],
  );

  /**
   * Open voice input — platform-appropriate method.
   * On iOS: uses Alert.prompt (native dictation via keyboard).
   * On Android: shows a text input modal for pasting voice text.
   */
  const openVoiceInput = useCallback(() => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Voice Input',
        'Tap the microphone on your keyboard and speak, or type what you want to add.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Parse',
            onPress: (text?: string) => {
              if (text && text.trim()) {
                processVoiceText(text.trim());
              }
            },
          },
        ],
        'plain-text',
        '',
        'default',
      );
    } else {
      setVoiceText('');
      setVoiceParsed(null);
      setVoiceModalVisible(true);
    }
  }, [processVoiceText]);

  /**
   * Confirm voice-parsed item from Android modal.
   */
  const handleVoiceParse = useCallback(() => {
    if (voiceText.trim()) {
      processVoiceText(voiceText.trim());
    }
  }, [voiceText, processVoiceText]);

  /**
   * Dismiss voice modal.
   */
  const handleVoiceDismiss = useCallback(() => {
    setVoiceModalVisible(false);
    setVoiceText('');
    setVoiceParsed(null);
  }, []);

  // ── Barcode Scanner Handlers ─────────────────────────────────────────────

  /**
   * Called when barcode scanner detects a code.
   */
  const handleBarcodeScanned = useCallback(
    async (barcode: string) => {
      setScanMode(false);
      setScanning(true);
      setScanError(null);
      setScanResult(null);

      try {
        const result: ScanResult = await lookupProduct(barcode);

        if (result.status === 'found') {
          // Pre-fill form with product details
          setScanResult({ barcode, product: result.product });
          setPendingImageUrl(result.product.imageUrl);
          setCustomName(result.product.productName);
          setCustomUnit(result.product.quantityLabel
            ? (result.product.quantityLabel.match(/[a-zA-Z]+/)?.[0] ?? 'pcs')
            : 'pcs'
          );
          setCustomQty(result.product.quantityLabel
            ? (result.product.quantityLabel.match(/\d+/)?.[0] ?? '1')
            : '1'
          );
          // Auto-detect category
          if (result.product.category) {
            const matched = BUILT_IN_CATEGORIES.find((c) =>
              result.product!.category!.toLowerCase().includes(c.toLowerCase()),
            );
            if (matched) setActiveTab(matched);
          }
        } else {
          // Not found anywhere — show new product form
          setScanResult({ barcode });
          setShowNewProductForm(true);
          setNewProductName('');
        }
      } catch (err) {
        setScanError(
          err instanceof Error ? err.message : 'Scan failed',
        );
      } finally {
        setScanning(false);
      }
    },
    [],
  );

  /**
   * Open barcode scanner UI. Barcode lookups send the scanned barcode to
   * Open Food Facts, so the consent prompt (persisted as
   * barcodeScanningEnabled) runs before the camera opens.
   */
  const openScanner = useCallback(() => {
    void ensureBarcodeLookupConsent().then((granted) => {
      if (!granted) return;
      setScanMode(true);
      setScanResult(null);
      setScanError(null);
      setShowNewProductForm(false);
    });
  }, []);

  /**
   * Save manually entered name for a product not found by barcode lookup.
   */
  const handleSaveNewProduct = useCallback(async () => {
    if (!scanResult?.barcode || !newProductName.trim()) return;
    setAdding(true);
    try {
      const { isTursoReady } = await import('../services/tursoClient');
      if (!isTursoReady()) {
        // The community product DB (Turso) is gated off in v1 — no client
        // credential path exists (see GOAL_PROMPT_NOTES.md). Keep the typed
        // name locally so the item can still be added to the list.
        setCustomName(newProductName.trim());
        setShowNewProductForm(false);
        return;
      }
      // Persist the new product to Turso so future scans find it
      const cleaned = await submitNewProduct({
        barcode: scanResult.barcode,
        rawName: newProductName.trim(),
      });
      setCustomName(cleaned.productName);
      setShowNewProductForm(false);
      setScanResult({
        barcode: scanResult.barcode,
        product: {
          barcode: cleaned.barcode,
          productName: cleaned.productName,
          brand: cleaned.brand ?? undefined,
          category: cleaned.category ?? undefined,
          imageUrl: cleaned.imageUrl ?? undefined,
          quantityLabel: cleaned.quantityLabel ?? undefined,
          source: 'turso',
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save product';
      Alert.alert('Error', message);
    } finally {
      setAdding(false);
    }
  }, [scanResult, newProductName]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: theme.bg }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={[styles.header, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>Add Item</Text>
          <TouchableOpacity onPress={handleClose} disabled={adding}>
            <Text style={[styles.closeText, { color: theme.primary }]}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Custom Item Input ─────────────────────────────────────── */}
          <View style={[styles.customSection, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <Text style={[styles.inputLabel, { color: theme.secondaryText }]}>ITEM NAME</Text>
            <TextInput
              style={[styles.customNameInput, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
              value={customName}
              onChangeText={setCustomName}
              placeholder="Type item name..."
              placeholderTextColor={activeTheme === 'dark' ? '#64748B' : '#94A3B8'}
              autoCapitalize="sentences"
              autoFocus
              returnKeyType="done"
              blurOnSubmit={false}
              onSubmitEditing={handleAddCustom}
            />

            <View style={styles.metaInputRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.inputLabel, { color: theme.secondaryText }]}>QUANTITY</Text>
                <View style={[styles.qtySelector, { backgroundColor: theme.inputBg, borderColor: theme.border }]}>
                  <TouchableOpacity
                    style={styles.qtyBtn}
                    onPress={() => {
                      const currentVal = parseInt(customQty, 10) || 1;
                      if (currentVal > 1) {
                        setCustomQty(String(currentVal - 1));
                      }
                    }}
                    activeOpacity={0.6}
                  >
                    <Text style={[styles.qtyBtnText, { color: theme.text }]}>-</Text>
                  </TouchableOpacity>
                  <TextInput
                    style={[styles.customQtyInputText, { color: theme.text }]}
                    value={customQty}
                    onChangeText={setCustomQty}
                    keyboardType="numeric"
                    textAlign="center"
                    returnKeyType="done"
                    blurOnSubmit={false}
                    onSubmitEditing={handleAddCustom}
                  />
                  <TouchableOpacity
                    style={styles.qtyBtn}
                    onPress={() => {
                      const currentVal = parseInt(customQty, 10) || 1;
                      setCustomQty(String(currentVal + 1));
                    }}
                    activeOpacity={0.6}
                  >
                    <Text style={[styles.qtyBtnText, { color: theme.text }]}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={{ width: 100 }}>
                <Text style={[styles.inputLabel, { color: theme.secondaryText }]}>UNIT</Text>
                <TextInput
                  style={[styles.customUnitInput, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
                  value={customUnit}
                  onChangeText={setCustomUnit}
                  placeholder="Unit"
                  placeholderTextColor={activeTheme === 'dark' ? '#64748B' : '#94A3B8'}
                  autoCapitalize="none"
                  returnKeyType="done"
                  blurOnSubmit={false}
                  onSubmitEditing={handleAddCustom}
                />
              </View>
            </View>

            <TouchableOpacity
              style={[
                styles.addBtn,
                { backgroundColor: theme.primary },
                (!customName.trim() || adding) && styles.addBtnDisabled,
              ]}
              onPress={handleAddCustom}
              disabled={!customName.trim() || adding}
            >
              {adding ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={[styles.addBtnText, { color: theme.btnText }]}>Add to List</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* ── Quick-Add Section ─────────────────────────────────────── */}
          <Text style={[styles.sectionLabel, { color: theme.secondaryText }]}>Quick Add</Text>

          {/* Category tabs */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.tabScroll}
            contentContainerStyle={styles.tabContent}
          >
            {CATEGORY_TABS.map((cat) => (
              <TouchableOpacity
                key={cat}
                style={[
                  styles.tab,
                  {
                    backgroundColor: activeTab === cat ? theme.tabActiveBg : theme.tabInactiveBg,
                    borderColor: activeTab === cat ? theme.tabActiveBg : theme.border,
                  },
                ]}
                onPress={() => setActiveTab(cat)}
              >
                <Text
                  style={[
                    styles.tabText,
                    {
                      color: activeTab === cat ? theme.tabActiveText : theme.tabInactiveText,
                      fontWeight: activeTab === cat ? '600' : '500',
                    },
                  ]}
                >
                  {cat.charAt(0).toUpperCase() + cat.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Quick items grid */}
          <View style={styles.quickGrid}>
            {(QUICK_ITEMS[activeTab] ?? []).map((quick) => (
              <TouchableOpacity
                key={quick.name}
                style={[
                  styles.quickChip,
                  {
                    backgroundColor: theme.cardBg,
                    borderColor: theme.border,
                  },
                ]}
                onPress={() =>
                  handleAddItem(
                    quick.name,
                    quick.category,
                    quick.unit,
                    quick.quantity,
                  )
                }
                disabled={adding}
              >
                <Text style={[styles.quickName, { color: theme.text }]}>{quick.name}</Text>
                <Text style={[styles.quickMeta, { color: theme.secondaryText }]}>
                  {quick.quantity} {quick.unit}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* ── Voice Input Section ───────────────────────────────────── */}
          <View style={styles.voiceSection}>
            <TouchableOpacity
              style={[styles.voiceBtn, { backgroundColor: theme.voiceBtnBg }]}
              onPress={openVoiceInput}
              disabled={adding || voiceProcessing}
              activeOpacity={0.7}
            >
              {voiceProcessing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.voiceBtnText}>🎤 Voice Input</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.voiceBtn, { backgroundColor: theme.primary }]}
              onPress={openScanner}
              disabled={adding}
              activeOpacity={0.7}
            >
              <Text style={styles.voiceBtnText}>📷 Scan Barcode</Text>
            </TouchableOpacity>
          </View>
          {onImportList && (
            <TouchableOpacity
              style={[styles.importBtn, { borderColor: theme.border, backgroundColor: theme.cardBg }]}
              onPress={() => {
                resetForm();
                onImportList();
              }}
              disabled={adding}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              <Text style={[styles.importBtnText, { color: theme.text }]}>📋 Import from Google Keep</Text>
            </TouchableOpacity>
          )}

          {/* Voice parse result indicator */}
          {voiceParsed && (
            <View style={[styles.voiceResult, { backgroundColor: theme.primary + '15' }]}>
              <Text style={[styles.voiceResultText, { color: theme.primary }]}>
                Voice Added: {voiceParsed.name} ({voiceParsed.quantity} {voiceParsed.unit})
              </Text>
            </View>
          )}

          {/* Barcode scan result */}
          {scanning && (
            <View style={[styles.voiceResult, { backgroundColor: theme.voiceBtnBg + '20' }]}>
              <ActivityIndicator size="small" color={theme.voiceBtnBg} />
              <Text style={[styles.voiceResultText, { color: theme.voiceBtnBg, marginTop: 6 }]}>
                Looking up product...
              </Text>
            </View>
          )}

          {scanError && (
            <View style={[styles.voiceResult, { backgroundColor: '#EF4444' + '15' }]}>
              <Text style={[styles.voiceResultText, { color: '#EF4444' }]}>
                {scanError}
              </Text>
            </View>
          )}

          {scanResult?.product && !showNewProductForm && (
            <View style={[styles.voiceResult, { backgroundColor: theme.primary + '15', flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
              {scanResult.product.imageUrl && (
                <Image
                  source={{ uri: scanResult.product.imageUrl }}
                  style={{ width: 48, height: 48, borderRadius: 8 }}
                  resizeMode="contain"
                />
              )}
              <View style={{ flex: 1 }}>
                <Text style={[styles.voiceResultText, { color: theme.primary }]}>
                  Scanned: {scanResult.product.productName}
                  {scanResult.product.brand ? ` (${scanResult.product.brand})` : ''}
                </Text>
                <Text style={[styles.voiceResultText, { color: theme.secondaryText, fontSize: 12, marginTop: 2 }]}>
                  from {scanResult.product.source.replace(/_/g, ' ')}
                </Text>
              </View>
            </View>
          )}

          {/* New product form — for items not found in any DB */}
          {showNewProductForm && scanResult && (
            <View style={[styles.customSection, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
              <Text style={[styles.inputLabel, { color: theme.secondaryText }]}>
                PRODUCT NOT FOUND
              </Text>
              <Text style={[styles.voiceResultText, { color: theme.text, marginBottom: 10 }]}>
                Barcode: {scanResult.barcode}
              </Text>
              <Text style={[styles.inputLabel, { color: theme.secondaryText }]}>
                ENTER PRODUCT NAME
              </Text>
              <TextInput
                style={[styles.customNameInput, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
                value={newProductName}
                onChangeText={setNewProductName}
                placeholder="e.g. Nutella Hazelnut Spread"
                placeholderTextColor={activeTheme === 'dark' ? '#64748B' : '#94A3B8'}
                autoCapitalize="sentences"
                autoFocus
              />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <TouchableOpacity
                  style={[styles.addBtn, { flex: 1, backgroundColor: theme.tabInactiveBg }]}
                  onPress={() => setShowNewProductForm(false)}
                >
                  <Text style={[styles.addBtnText, { color: theme.text }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.addBtn,
                    { flex: 1, backgroundColor: theme.primary },
                    !newProductName.trim() && styles.addBtnDisabled,
                  ]}
                  onPress={handleSaveNewProduct}
                  disabled={!newProductName.trim()}
                >
                  <Text style={[styles.addBtnText, { color: theme.btnText }]}>Use Name</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>

        {/* ── Android Voice Text Input Modal ─────────────────────────── */}
        <Modal
          visible={voiceModalVisible}
          animationType="fade"
          transparent
          onRequestClose={handleVoiceDismiss}
        >
          <View style={[styles.voiceOverlay, { backgroundColor: theme.modalOverlay }]}>
            <View style={[styles.voiceDialog, { backgroundColor: theme.cardBg }]}>
              <Text style={[styles.voiceDialogTitle, { color: theme.text }]}>Voice Input</Text>
              <Text style={[styles.voiceDialogHint, { color: theme.secondaryText }]}>
                Type or paste what you want to add, or use your keyboard's
                microphone for dictation.
              </Text>
              <TextInput
                style={[styles.voiceDialogInput, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
                value={voiceText}
                onChangeText={setVoiceText}
                placeholder='e.g. "2% milk x2" or "half a kilo of chicken"'
                placeholderTextColor={activeTheme === 'dark' ? '#64748B' : '#94A3B8'}
                autoCapitalize="sentences"
                autoFocus
                multiline
              />
              <View style={styles.voiceDialogActions}>
                <TouchableOpacity
                  style={[styles.voiceDialogCancel, { backgroundColor: theme.tabInactiveBg }]}
                  onPress={handleVoiceDismiss}
                >
                  <Text style={[styles.voiceDialogCancelText, { color: theme.tabInactiveText }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.voiceDialogParse,
                    { backgroundColor: theme.voiceBtnBg },
                    !voiceText.trim() && styles.voiceDialogParseDisabled,
                  ]}
                  onPress={handleVoiceParse}
                  disabled={!voiceText.trim()}
                >
                  <Text style={styles.voiceDialogParseText}>Parse</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

      </KeyboardAvoidingView>

      {/* ── Barcode Scanner Overlay (outside KeyboardAvoidingView to avoid framing issues) ── */}
      {scanMode && (
        <View style={StyleSheet.absoluteFill}>
          <BarcodeScannerScreen
            onScan={handleBarcodeScanned}
            onCancel={() => setScanMode(false)}
          />
        </View>
      )}
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 50,
    paddingBottom: 14,

  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  closeText: {
    fontSize: 16,
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 16,
  },
  customSection: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  customNameInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    height: 44,
  },
  metaInputRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  qtySelector: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    height: 44,
    overflow: 'hidden',
  },
  qtyBtn: {
    width: 40,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  qtyBtnText: {
    fontSize: 18,
    fontWeight: '600',
  },
  customQtyInputText: {
    flex: 1,
    height: '100%',
    fontSize: 15,
    fontWeight: '600',
    padding: 0,
  },
  customUnitInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 15,
  },
  addBtn: {
    borderRadius: 8,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addBtnDisabled: {
    opacity: 0.5,
  },
  addBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  tabScroll: {
    marginBottom: 8,
  },
  tabContent: {
    gap: 6,
    paddingVertical: 4,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  tabText: {
    fontSize: 13,
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  quickChip: {
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    minWidth: 100,
    flex: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  quickName: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  quickMeta: {
    fontSize: 11,
  },
  voiceSection: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  voiceBtn: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  importBtn: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    alignItems: 'center',
  },
  importBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  voiceBtnDisabled: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    opacity: 0.6,
  },
  voiceBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  voiceBadge: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  voiceResult: {
    borderRadius: 8,
    padding: 10,
    marginTop: 12,
  },
  voiceResultText: {
    fontSize: 13,
    fontWeight: '500',
  },
  // ── Voice Modal (Android) ─────────────────────────────────────────────
  voiceOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  voiceDialog: {
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 400,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  voiceDialogTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  voiceDialogHint: {
    fontSize: 13,
    marginBottom: 12,
    lineHeight: 18,
  },
  voiceDialogInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 12,
  },
  voiceDialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  voiceDialogCancel: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  voiceDialogCancelText: {
    fontSize: 14,
    fontWeight: '600',
  },
  voiceDialogParse: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  voiceDialogParseDisabled: {
    opacity: 0.5,
  },
  voiceDialogParseText: {
    fontSize: 14,
    color: '#fff',
    fontWeight: '600',
  },
});