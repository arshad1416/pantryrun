/**
 * ItemEditScreen — edit or create a grocery item.
 *
 * Provides fields for: name, quantity stepper, unit/category pickers,
 * notes area, and save action. Used both for editing existing items
 * and as the detail view after quick-add.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BUILT_IN_CATEGORIES } from '../types';
import type { GroceryItem } from '../types';
import { useGroceryStore } from '../state/useGroceryStore';
import { useFamilyStore } from '../state/useFamilyStore';
import type { RootStackParamList } from '../navigation/deepLinks';
import { usePriceStore } from '../pricing/price-store';
import { useListStore } from '../state/useListStore';
import { crowdsourcedAdapter } from '../pricing/crowdsourced';
import { buildManualOffer } from '../pricing/manual-offer';
import { getEvidence, PROVENANCE_LABEL } from '../pricing/offer-evidence';

// ─── Props ──────────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<RootStackParamList, 'ItemEdit'>;

// ─── Common Units ────────────────────────────────────────────────────────────

const COMMON_UNITS = ['pcs', 'oz', 'lb', 'g', 'kg', 'ml', 'L', 'tsp', 'tbsp', 'cup', 'bunch', 'bag', 'box', 'jar'];

// ─── Main Screen ─────────────────────────────────────────────────────────────

export default function ItemEditScreen({ route, navigation }: Props) {
  const { listId, itemId } = route.params;
  const insets = useSafeAreaInsets();
  const isEditing = !!itemId;

  // Store
  const items = useGroceryStore((s) => s.items);
  const addItem = useGroceryStore((s) => s.addItem);
  const updateItem = useGroceryStore((s) => s.updateItem);
  const activeMemberId = useFamilyStore((s) => s.activeMemberId);

  // Form state
  const existingItem: GroceryItem | undefined = itemId ? items[itemId] : undefined;

  const [name, setName] = useState(existingItem?.name ?? '');
  const [quantity, setQuantity] = useState(existingItem?.quantity ?? 1);
  const [unit, setUnit] = useState(existingItem?.unit ?? 'pcs');
  const [category, setCategory] = useState(existingItem?.category ?? 'other');
  const [notes, setNotes] = useState(existingItem?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [showUnitPicker, setShowUnitPicker] = useState(false);
  // Price submission state
  const [showPriceForm, setShowPriceForm] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const [priceStoreInput, setPriceStoreInput] = useState('');
  const [pricePackageInput, setPricePackageInput] = useState('');
  const [priceByWeight, setPriceByWeight] = useState<'per_kg' | 'per_lb' | null>(null);
  const [priceSaleEndsInput, setPriceSaleEndsInput] = useState('');
  const submitCrowdPrice = usePriceStore((s) => s.submitCrowdPrice);
  const loadSinglePrice = usePriceStore((s) => s.loadSinglePrice);
  const prices = usePriceStore((s) => s.prices);
  const itemPrice = itemId ? prices[itemId] : null;

  // Load price when item becomes available
  const editStorePref = useListStore((s) => s.lists[listId]?.storePreference);
  const editStoreId = editStorePref ?? 'default';
  useEffect(() => {
    if (existingItem && itemId) {
      loadSinglePrice(itemId, existingItem.name, editStoreId);
    }
  }, [existingItem?.id, itemId, editStoreId, loadSinglePrice]);

  // Sync local state when item changes (e.g., from re-hydration)
  useEffect(() => {
    if (existingItem) {
      setName(existingItem.name);
      setQuantity(existingItem.quantity);
      setUnit(existingItem.unit);
      setCategory(existingItem.category);
      setNotes(existingItem.notes ?? '');
    }
  }, [existingItem]);

  // Save handler
  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      Alert.alert('Required', 'Item name is required.');
      return;
    }

    setSaving(true);
    try {
      if (isEditing && existingItem) {
        await updateItem(existingItem.id, {
          name: name.trim(),
          quantity,
          unit,
          category,
          notes: notes.trim() || undefined,
        });
      } else {
        // Get max sort order from existing items
        const listItems = Object.values(items).filter(
          (i) => i.listId === listId && !i.isDeleted,
        );
        const maxSort = listItems.length > 0
          ? Math.max(...listItems.map((i) => i.sortOrder))
          : 0;

        // Resolve familyId using same logic as AddItemSheet
        const familyId =
          listItems.length > 0
            ? listItems[0].familyId
            : Object.values(useFamilyStore.getState().members).length > 0
              ? Object.values(useFamilyStore.getState().members)[0].familyId
              : '';

        await addItem({
          listId,
          familyId,
          name: name.trim(),
          quantity,
          unit,
          category,
          isChecked: false,
          addedBy: activeMemberId ?? 'unknown',
          notes: notes.trim() || undefined,
          sortOrder: maxSort + 1,
        });
      }
      navigation.goBack();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save';
      Alert.alert('Error', message);
    } finally {
      setSaving(false);
    }
  }, [
    name,
    quantity,
    unit,
    category,
    notes,
    isEditing,
    existingItem,
    items,
    listId,
    activeMemberId,
    addItem,
    updateItem,
    navigation,
  ]);

  // Quantity stepper
  const incrementQty = useCallback(() => setQuantity((q) => q + 1), []);
  const decrementQty = useCallback(
    () => setQuantity((q) => Math.max(1, q - 1)),
    [],
  );
  const handleQtyChange = useCallback((text: string) => {
    const num = parseInt(text, 10);
    if (!isNaN(num) && num > 0) setQuantity(num);
  }, []);

  // Delete handler
  const handleDelete = useCallback(() => {
    if (!existingItem) return;
    Alert.alert('Delete Item', `Delete "${existingItem.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await useGroceryStore.getState().deleteItem(existingItem.id);
            navigation.goBack();
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to delete';
            Alert.alert('Error', message);
          }
        },
      },
    ]);
  }, [existingItem, navigation]);

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {isEditing ? 'Edit Item' : 'New Item'}
        </Text>
        <TouchableOpacity onPress={handleSave} disabled={saving}>
          {saving ? (
            <ActivityIndicator size="small" color="#4CAF50" />
          ) : (
            <Text style={styles.saveText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Name */}
      <View style={styles.section}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.nameInput}
          value={name}
          onChangeText={setName}
          placeholder="Item name"
          placeholderTextColor="#bbb"
          autoFocus={!isEditing}
          autoCapitalize="sentences"
        />
      </View>

      {/* Quantity */}
      <View style={styles.section}>
        <Text style={styles.label}>Quantity</Text>
        <View style={styles.quantityRow}>
          <TouchableOpacity style={styles.qtyButton} onPress={decrementQty}>
            <Text style={styles.qtyButtonText}>−</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.qtyInput}
            value={String(quantity)}
            onChangeText={handleQtyChange}
            keyboardType="numeric"
            selectTextOnFocus
          />
          <TouchableOpacity style={styles.qtyButton} onPress={incrementQty}>
            <Text style={styles.qtyButtonText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Unit */}
      <View style={styles.section}>
        <Text style={styles.label}>Unit</Text>
        <TouchableOpacity
          style={styles.pickerButton}
          onPress={() => setShowUnitPicker(!showUnitPicker)}
        >
          <Text style={styles.pickerButtonText}>{unit}</Text>
          <Text style={styles.pickerArrow}>{showUnitPicker ? '▲' : '▼'}</Text>
        </TouchableOpacity>
        {showUnitPicker && (
          <View style={styles.pickerGrid}>
            {COMMON_UNITS.map((u) => (
              <TouchableOpacity
                key={u}
                style={[
                  styles.unitChip,
                  unit === u && styles.unitChipActive,
                ]}
                onPress={() => {
                  setUnit(u);
                  setShowUnitPicker(false);
                }}
              >
                <Text
                  style={[
                    styles.unitChipText,
                    unit === u && styles.unitChipTextActive,
                  ]}
                >
                  {u}
                </Text>
              </TouchableOpacity>
            ))}
            <TextInput
              style={styles.customUnitInput}
              value={!COMMON_UNITS.includes(unit) ? unit : ''}
              onChangeText={(v) => setUnit(v || 'pcs')}
              placeholder="Custom"
              placeholderTextColor="#bbb"
              autoCapitalize="none"
            />
          </View>
        )}
      </View>

      {/* Category */}
      <View style={styles.section}>
        <Text style={styles.label}>Category</Text>
        <View style={styles.categoryGrid}>
          {BUILT_IN_CATEGORIES.map((cat) => (
            <TouchableOpacity
              key={cat}
              style={[
                styles.categoryChip,
                category === cat && styles.categoryChipActive,
              ]}
              onPress={() => setCategory(cat)}
            >
              <Text
                style={[
                  styles.categoryChipText,
                  category === cat && styles.categoryChipTextActive,
                ]}
              >
                {cat.charAt(0).toUpperCase() + cat.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Notes */}
      <View style={styles.section}>
        <Text style={styles.label}>Notes</Text>
        <TextInput
          style={styles.notesInput}
          value={notes}
          onChangeText={setNotes}
          placeholder="Add notes..."
          placeholderTextColor="#bbb"
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </View>

      {/* Price History (edit mode only) */}
      {isEditing && (
        <>
          {/* Price section */}
          <View style={styles.section}>
            <Text style={styles.label}>Price</Text>
            {itemPrice ? (
              <View>
                <Text style={styles.priceValue}>
                  ${itemPrice.price.toFixed(2)}
                </Text>
                <Text style={styles.priceMeta}>
                  {itemPrice.source.storeName} · {PROVENANCE_LABEL[getEvidence(itemPrice).provenance]}
                  {getEvidence(itemPrice).validTo ? ` · until ${getEvidence(itemPrice).validTo}` : ''}
                </Text>
              </View>
            ) : (
              <Text style={styles.priceEmpty}>No price data available</Text>
            )}

            {/* Log Price button */}
            <TouchableOpacity
              style={styles.logPriceBtn}
              onPress={() => setShowPriceForm(!showPriceForm)}
            >
              <Text style={styles.logPriceBtnText}>
                {showPriceForm ? 'Cancel' : 'Log Price'}
              </Text>
            </TouchableOpacity>

            {showPriceForm && (
              <View style={styles.priceForm}>
                <TextInput
                  style={styles.priceInputField}
                  value={priceInput}
                  onChangeText={setPriceInput}
                  placeholder="Price (e.g. 4.99)"
                  keyboardType="decimal-pad"
                  placeholderTextColor="#bbb"
                />
                <TextInput
                  style={styles.priceInputField}
                  value={priceStoreInput}
                  onChangeText={setPriceStoreInput}
                  placeholder="Store name"
                  placeholderTextColor="#bbb"
                />
                <View style={styles.weightRow}>
                  {(['per_kg', 'per_lb'] as const).map((basis) => (
                    <TouchableOpacity
                      key={basis}
                      style={[styles.weightChip, priceByWeight === basis && styles.weightChipActive]}
                      onPress={() => setPriceByWeight(priceByWeight === basis ? null : basis)}
                      accessibilityRole="switch"
                      accessibilityState={{ checked: priceByWeight === basis }}
                    >
                      <Text style={[styles.weightChipText, priceByWeight === basis && styles.weightChipTextActive]}>
                        {basis === 'per_kg' ? 'Price per kg' : 'Price per lb'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {!priceByWeight && (
                  <TextInput
                    style={styles.priceInputField}
                    value={pricePackageInput}
                    onChangeText={setPricePackageInput}
                    placeholder="Package size, optional (e.g. 340 g)"
                    placeholderTextColor="#bbb"
                  />
                )}
                <TextInput
                  style={styles.priceInputField}
                  value={priceSaleEndsInput}
                  onChangeText={setPriceSaleEndsInput}
                  placeholder="Sale ends, optional (YYYY-MM-DD)"
                  placeholderTextColor="#bbb"
                />
                <TouchableOpacity
                  style={styles.submitPriceBtn}
                  onPress={async () => {
                    if (!priceInput || !priceStoreInput || !existingItem) return;
                    const offer = buildManualOffer({
                      itemName: existingItem.name,
                      price: priceInput,
                      storeName: priceStoreInput,
                      packageSize: priceByWeight ? undefined : pricePackageInput,
                      byWeight: priceByWeight ?? undefined,
                      saleEnds: priceSaleEndsInput,
                      submittedBy: activeMemberId ?? 'unknown',
                    });
                    if (!offer.ok) {
                      Alert.alert('Invalid', offer.error);
                      return;
                    }
                    try {
                      await submitCrowdPrice(offer.submission, existingItem.id, existingItem.name);
                      Alert.alert('Submitted', 'Price logged. Comparisons now use it.');
                      setShowPriceForm(false);
                      setPriceInput('');
                      setPriceStoreInput('');
                      setPricePackageInput('');
                      setPriceByWeight(null);
                      setPriceSaleEndsInput('');
                    } catch (err) {
                      Alert.alert('Error', 'Failed to submit price');
                    }
                  }}
                >
                  <Text style={styles.submitPriceBtnText}>Submit</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Receipt scan placeholder */}
          <TouchableOpacity
            style={styles.receiptScanBtn}
            onPress={async () => {
              Alert.alert(
                'Receipt Scan',
                'Receipt scanning is not yet implemented (OCR coming soon).',
              );
            }}
          >
            <Text style={styles.receiptScanText}>📷 Scan Receipt</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Delete button (edit mode only) */}
      {isEditing && (
        <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
          <Text style={styles.deleteText}>Delete Item</Text>
        </TouchableOpacity>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  cancelText: {
    fontSize: 16,
    color: '#666',
  },
  saveText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4CAF50',
  },
  section: {
    margin: 12,
    marginTop: 8,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  label: {
    fontSize: 13,
    color: '#666',
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  nameInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#333',
    backgroundColor: '#fafafa',
  },
  quantityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  qtyButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  qtyButtonText: {
    fontSize: 20,
    color: '#333',
    fontWeight: '600',
  },
  qtyInput: {
    width: 60,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 8,
    fontSize: 18,
    textAlign: 'center',
    color: '#333',
    backgroundColor: '#fafafa',
  },
  pickerButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#fafafa',
  },
  pickerButtonText: {
    fontSize: 15,
    color: '#333',
  },
  pickerArrow: {
    fontSize: 12,
    color: '#999',
  },
  pickerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  unitChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f0f0f0',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  unitChipActive: {
    backgroundColor: '#4CAF50',
    borderColor: '#4CAF50',
  },
  unitChipText: {
    fontSize: 13,
    color: '#555',
  },
  unitChipTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  customUnitInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 13,
    color: '#333',
    backgroundColor: '#fafafa',
    minWidth: 80,
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  categoryChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f0f0f0',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  categoryChipActive: {
    backgroundColor: '#4CAF50',
    borderColor: '#4CAF50',
  },
  categoryChipText: {
    fontSize: 13,
    color: '#555',
  },
  categoryChipTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  notesInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#333',
    backgroundColor: '#fafafa',
    minHeight: 72,
  },
  deleteButton: {
    margin: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#f44336',
  },
  deleteText: {
    fontSize: 15,
    color: '#f44336',
    fontWeight: '600',
  },
  priceValue: {
    fontSize: 22,
    fontWeight: '700',
    color: '#333',
    marginBottom: 4,
  },
  weightRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  weightChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  weightChipActive: {
    borderColor: '#16A34A',
    backgroundColor: '#16A34A',
  },
  weightChipText: {
    fontSize: 12,
    color: '#555',
  },
  weightChipTextActive: {
    color: '#FFFFFF',
  },
  priceMeta: {
    fontSize: 12,
    color: '#999',
    marginBottom: 8,
  },
  priceEmpty: {
    fontSize: 13,
    color: '#999',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  logPriceBtn: {
    backgroundColor: '#4CAF50',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 4,
  },
  logPriceBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  priceForm: {
    marginTop: 12,
    gap: 8,
  },
  priceInputField: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    color: '#333',
    backgroundColor: '#fafafa',
  },
  submitPriceBtn: {
    backgroundColor: '#2196F3',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  submitPriceBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  receiptScanBtn: {
    margin: 12,
    marginTop: 0,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FF9800',
  },
  receiptScanText: {
    fontSize: 14,
    color: '#FF9800',
    fontWeight: '600',
  },
});