/**
 * ImportListSheet — paste a Google Keep list and add its items.
 *
 * Keep has no consumer API, so the flow is: in Keep, ⋮ → Send → Copy to
 * clipboard; paste here. The preview shows what will be added, which store
 * heading each item was under, which items are a different variant of
 * another line or of something already on the list, and what was skipped
 * (ticked in Keep — named, so they can be added as checked — duplicates,
 * already on this list) before anything is written.
 */

import React, { useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Switch,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useGroceryStore } from '../state/useGroceryStore';
import { useFamilyStore } from '../state/useFamilyStore';
import { useActiveTheme } from '../state/useThemeStore';
import { themeColors } from '../components/groceryTheme';
import { parseKeepList, type SkipReason } from '../import/keep';
import { selectBasketItems } from '../pricing/basket';
import { inferCategory } from '../utils/inferCategory';
import { friendlyError } from '../utils/friendlyError';
import type { GroceryCategory } from '../types';

interface ImportListSheetProps {
  visible: boolean;
  listId: string;
  onClose: () => void;
  /** Called with the IDs of the items added (for undo) */
  onImported?: (itemIds: string[]) => void;
}

const SKIP_LABELS: Record<SkipReason, string> = {
  ticked: 'ticked in Keep',
  duplicate: 'listed twice',
  already_on_list: 'already on this list',
  not_an_item: 'not an item',
};

export default function ImportListSheet({ visible, listId, onClose, onImported }: ImportListSheetProps) {
  const addItem = useGroceryStore((s) => s.addItem);
  const items = useGroceryStore((s) => s.items);
  const activeMemberId = useFamilyStore((s) => s.activeMemberId);
  const familyMembers = useFamilyStore((s) => s.members);
  const activeTheme = useActiveTheme();
  const theme = themeColors[activeTheme];

  const [text, setText] = useState('');
  const [includeChecked, setIncludeChecked] = useState(false);
  const [importing, setImporting] = useState(false);

  const existingItems = useMemo(
    () => selectBasketItems(items, listId).map((i) => ({ name: i.name, notes: i.notes })),
    [items, listId],
  );
  const result = useMemo(
    () => parseKeepList(text, { includeChecked, existingItems }),
    [text, includeChecked, existingItems],
  );

  // Ticked lines are named (not just counted) so the person can see what
  // the switch below would add as already-checked items.
  const tickedLines = useMemo(
    () => result.skipped.filter((s) => s.reason === 'ticked').map((s) => s.text),
    [result.skipped],
  );
  const skippedSummary = useMemo(() => {
    const counts = new Map<SkipReason, number>();
    for (const s of result.skipped) {
      if (s.reason !== 'ticked') counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
    }
    return Array.from(counts, ([reason, n]) => `${n} ${SKIP_LABELS[reason]}`).join(' · ');
  }, [result.skipped]);
  const conflictCount = result.items.filter((i) => i.variantConflicts?.length).length;

  const handleClose = useCallback(() => {
    setText('');
    setIncludeChecked(false);
    onClose();
  }, [onClose]);

  const handleImport = useCallback(async () => {
    if (result.items.length === 0) return;
    setImporting(true);
    try {
      const listItems = Object.values(items).filter((i) => i.listId === listId);
      const familyId =
        listItems[0]?.familyId ?? Object.values(familyMembers)[0]?.familyId ?? '';
      let sortOrder = listItems.length > 0 ? Math.max(...listItems.map((i) => i.sortOrder)) : 0;

      const added: string[] = [];
      for (const item of result.items) {
        sortOrder += 1;
        const created = await addItem(
          {
            listId,
            familyId,
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
            category: inferCategory(item.name) as GroceryCategory,
            isChecked: item.checked,
            addedBy: activeMemberId ?? 'import',
            sortOrder,
            ...(item.notes ? { notes: item.notes } : {}),
          },
          { silent: true },
        );
        added.push(created.id);
      }
      setText('');
      setIncludeChecked(false);
      onImported?.(added);
    } catch (err) {
      Alert.alert('Import stopped', `${friendlyError(err as Error)}\n\nItems added before the error stay on the list.`);
    } finally {
      setImporting(false);
    }
  }, [result.items, items, listId, familyMembers, addItem, activeMemberId, onImported]);

  const count = result.items.length;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: theme.bg }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.header, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>Import from Google Keep</Text>
          <TouchableOpacity onPress={handleClose} disabled={importing}>
            <Text style={[styles.closeText, { color: theme.primary }]}>Cancel</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <Text style={[styles.hint, { color: theme.secondaryText }]}>
            In Keep, open the list, tap ⋮ → Send → Copy to clipboard, then paste below. Store
            headings like "Costco:" are kept as a note on the items under them.
          </Text>

          <TextInput
            style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
            value={text}
            onChangeText={setText}
            placeholder={'Groceries\n☐ green grapes\n☐ 2L milk (lactose free)\nCostco:\n☐ paper towels'}
            placeholderTextColor={activeTheme === 'dark' ? '#64748B' : '#94A3B8'}
            multiline
            autoCorrect={false}
            autoCapitalize="none"
            textAlignVertical="top"
            accessibilityLabel="Pasted Google Keep list"
          />

          <View style={[styles.toggleRow, { borderColor: theme.border }]}>
            <Text style={[styles.toggleLabel, { color: theme.text }]}>Include items ticked in Keep</Text>
            <Switch value={includeChecked} onValueChange={setIncludeChecked} />
          </View>

          {text.trim().length > 0 && (
            <View style={[styles.preview, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
              <Text style={[styles.previewTitle, { color: theme.text }]}>
                {count === 0 ? 'Nothing to add' : `${count} item${count === 1 ? '' : 's'} to add`}
                {result.title ? ` from "${result.title}"` : ''}
              </Text>
              {conflictCount > 0 && (
                <Text style={[styles.warning, { color: theme.unassignedText }]}>
                  ⚠ {conflictCount} item{conflictCount === 1 ? ' is a different variant' : 's are different variants'} of
                  another line or of something on your list. They'll be added separately — check they're what you meant.
                </Text>
              )}
              {result.items.map((item, idx) => (
                <View key={`${item.name}-${idx}`} style={[styles.previewRow, { borderTopColor: theme.divider }]}>
                  <Text style={[styles.previewName, { color: theme.text }]} numberOfLines={1}>
                    {item.checked ? '☑ ' : ''}
                    {item.name}
                    {item.quantity !== 1 || (item.unit && item.unit !== 'each') ? `  ×${item.quantity}${item.unit && item.unit !== 'each' ? ` ${item.unit}` : ''}` : ''}
                  </Text>
                  {item.notes ? (
                    <Text style={[styles.previewNote, { color: theme.secondaryText }]} numberOfLines={1}>
                      {item.notes}
                    </Text>
                  ) : null}
                  {item.checked ? (
                    <Text style={[styles.previewNote, { color: theme.secondaryText }]}>
                      Ticked in Keep — added as already checked
                    </Text>
                  ) : null}
                  {item.variantConflicts?.length ? (
                    <Text style={[styles.previewNote, { color: theme.unassignedText }]} numberOfLines={2}>
                      ⚠ Different variant of: {item.variantConflicts.join(', ')}
                    </Text>
                  ) : null}
                </View>
              ))}
              {tickedLines.length > 0 ? (
                <Text style={[styles.skipped, { color: theme.secondaryText }]}>
                  Ticked in Keep, not added: {tickedLines.join(', ')}. Turn on "Include items ticked in Keep" to add
                  {tickedLines.length === 1 ? ' it' : ' them'} as already checked.
                </Text>
              ) : null}
              {skippedSummary ? (
                <Text style={[styles.skipped, { color: theme.secondaryText }]}>Skipped: {skippedSummary}</Text>
              ) : null}
            </View>
          )}
        </ScrollView>

        <TouchableOpacity
          style={[styles.importBtn, { backgroundColor: theme.primary }, (count === 0 || importing) && styles.importBtnDisabled]}
          onPress={handleImport}
          disabled={count === 0 || importing}
          accessibilityRole="button"
        >
          {importing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.importBtnText}>
              {count === 0 ? 'Import' : `Import ${count} item${count === 1 ? '' : 's'}`}
            </Text>
          )}
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 50,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 18, fontWeight: '700' },
  closeText: { fontSize: 16, fontWeight: '600' },
  scroll: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 24 },
  hint: { fontSize: 13, lineHeight: 18, marginBottom: 10 },
  input: {
    minHeight: 160,
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    fontSize: 15,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    marginTop: 4,
  },
  toggleLabel: { fontSize: 14 },
  preview: { borderRadius: 12, borderWidth: 1, padding: 12, marginTop: 8 },
  previewTitle: { fontSize: 14, fontWeight: '700', marginBottom: 6 },
  previewRow: { paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth },
  previewName: { fontSize: 14 },
  previewNote: { fontSize: 12, marginTop: 1 },
  skipped: { fontSize: 12, marginTop: 8 },
  warning: { fontSize: 12, lineHeight: 16, marginBottom: 6 },
  importBtn: {
    margin: 12,
    borderRadius: 10,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  importBtnDisabled: { opacity: 0.5 },
  importBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
