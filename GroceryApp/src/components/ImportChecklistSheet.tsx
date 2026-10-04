/**
 * ImportChecklistSheet — paste a checklist (e.g. copied out of Google Keep),
 * review the preview, then add the confirmed lines to the list.
 *
 * Nothing is written until "Import" is pressed, and Import stays disabled
 * while any flagged line marked "Add" has not been reviewed. Parsing and
 * duplicate rules live in src/import/checklist-import.ts.
 */

import React, { useMemo, useState, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import {
  previewImport,
  refreshPreview,
  itemsToAdd,
  describeIntent,
  type ImportEntry,
  type ExistingItem,
} from '../import/checklist-import';
import { useActiveTheme } from '../state/useThemeStore';
import { themeColors } from './groceryTheme';

interface ImportChecklistSheetProps {
  visible: boolean;
  existingItems: ExistingItem[];
  onClose: () => void;
  /** Adds the confirmed items; resolves when all are written. */
  onImport: (items: ReturnType<typeof itemsToAdd>) => Promise<void>;
}

export default function ImportChecklistSheet({ visible, existingItems, onClose, onImport }: ImportChecklistSheetProps) {
  const activeTheme = useActiveTheme();
  const theme = themeColors[activeTheme];
  const [text, setText] = useState('');
  const [entries, setEntries] = useState<ImportEntry[] | null>(null);
  const [importing, setImporting] = useState(false);

  const summary = useMemo(() => (entries ? refreshPreview(entries) : null), [entries]);

  const reset = useCallback(() => {
    setText('');
    setEntries(null);
    setImporting(false);
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const update = (key: string, patch: Partial<ImportEntry>) =>
    setEntries((prev) => prev && prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  const confirm = async () => {
    if (!entries || !summary || importing || summary.needsReview > 0 || summary.toAdd === 0) return;
    setImporting(true);
    try {
      await onImport(itemsToAdd(entries));
      close();
    } catch (err) {
      Alert.alert('Import failed', err instanceof Error ? err.message : 'Could not add the items');
      setImporting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>Import a checklist</Text>
          <TouchableOpacity onPress={close} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={[styles.close, { color: theme.secondaryText }]}>✕</Text>
          </TouchableOpacity>
        </View>

        {!entries ? (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={[styles.help, { color: theme.secondaryText }]}>
              Paste a checklist (for example, open the note in Google Keep, select all, copy). Checked lines,
              headings like “Costco” and notes are kept; you review everything before it is added.
            </Text>
            <TextInput
              style={[styles.paste, { color: theme.text, borderColor: theme.border, backgroundColor: theme.cardBg }]}
              value={text}
              onChangeText={setText}
              multiline
              placeholder={'☐ GREEN grapes 1.5 kg\n☐ ketchup (sale only)\nCostco\n☐ cheddar 500 g'}
              placeholderTextColor={theme.secondaryText}
              textAlignVertical="top"
              accessibilityLabel="Checklist text"
            />
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: text.trim() ? theme.primary : theme.disabledText }]}
              disabled={!text.trim()}
              onPress={() => setEntries(previewImport(text, existingItems).entries)}
            >
              <Text style={styles.primaryBtnText}>Preview</Text>
            </TouchableOpacity>
          </ScrollView>
        ) : (
          <>
            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
              {entries.map((e) => {
                if (e.kind === 'heading') {
                  return (
                    <View key={e.key} style={styles.headingRow}>
                      <Text style={[styles.heading, { color: theme.text }]}>{e.name}</Text>
                      <Text style={[styles.flag, { color: theme.secondaryText }]}>{e.flags[0]}</Text>
                    </View>
                  );
                }
                const adding = e.action === 'add';
                const intent = describeIntent(e);
                const needsLook = adding && !e.reviewed;
                return (
                  <View
                    key={e.key}
                    style={[
                      styles.entry,
                      { backgroundColor: theme.cardBg, borderColor: needsLook ? theme.unassignedBorder : theme.border },
                    ]}
                  >
                    <View style={styles.entryTop}>
                      <TouchableOpacity
                        onPress={() => update(e.key, { action: adding ? 'skip' : 'add' })}
                        style={[styles.actionChip, { backgroundColor: adding ? theme.primary : theme.inactiveBg }]}
                        accessibilityRole="switch"
                        accessibilityState={{ checked: adding }}
                      >
                        <Text style={[styles.actionText, { color: adding ? '#FFFFFF' : theme.text }]}>{adding ? 'Add' : 'Skip'}</Text>
                      </TouchableOpacity>
                      <Text style={[styles.checkMark, { color: theme.secondaryText }]}>{e.checked ? '☑' : '☐'}</Text>
                      <TextInput
                        style={[styles.nameInput, { color: theme.text, borderColor: theme.border }]}
                        value={e.name}
                        onChangeText={(name) => update(e.key, { name })}
                        accessibilityLabel={`Item name, line ${e.lineNo}`}
                      />
                    </View>
                    <View style={styles.qtyRow}>
                      <TextInput
                        style={[styles.qtyInput, { color: theme.text, borderColor: theme.border }]}
                        value={e.quantity == null ? '' : String(e.quantity)}
                        onChangeText={(t) => {
                          const n = parseFloat(t.replace(',', '.'));
                          update(e.key, { quantity: t.trim() === '' || !Number.isFinite(n) ? null : n });
                        }}
                        keyboardType="decimal-pad"
                        placeholder="qty?"
                        placeholderTextColor={theme.secondaryText}
                        accessibilityLabel={`Quantity, line ${e.lineNo}`}
                      />
                      <TextInput
                        style={[styles.unitInput, { color: theme.text, borderColor: theme.border }]}
                        value={e.unit}
                        onChangeText={(unit) => update(e.key, { unit })}
                        placeholder="unit"
                        placeholderTextColor={theme.secondaryText}
                        accessibilityLabel={`Unit, line ${e.lineNo}`}
                      />
                      {intent.length > 0 && (
                        <Text style={[styles.intent, { color: theme.secondaryText }]} numberOfLines={2}>
                          {intent.join(' · ')}
                        </Text>
                      )}
                    </View>
                    {e.flags.map((f) => (
                      <Text key={f} style={[styles.flag, { color: theme.unassignedText }]}>⚠️ {f}</Text>
                    ))}
                    {adding && e.flags.length > 0 && (
                      <TouchableOpacity
                        onPress={() => update(e.key, { reviewed: !e.reviewed })}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: e.reviewed }}
                      >
                        <Text style={[styles.reviewed, { color: e.reviewed ? theme.primary : theme.text }]}>
                          {e.reviewed ? '☑' : '☐'} Reviewed — add as shown
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </ScrollView>
            <View style={[styles.footer, { borderTopColor: theme.border }]}>
              <Text style={[styles.help, { color: theme.secondaryText }]}>
                {summary!.toAdd} to add · {entries.filter((e) => e.kind !== 'heading' && e.action === 'skip').length} skipped
                {summary!.needsReview > 0 ? ` · review ${summary!.needsReview} flagged line${summary!.needsReview === 1 ? '' : 's'} first` : ''}
              </Text>
              <View style={styles.footerRow}>
                <TouchableOpacity style={[styles.secondaryBtn, { borderColor: theme.border }]} onPress={() => setEntries(null)}>
                  <Text style={[styles.secondaryBtnText, { color: theme.text }]}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    styles.flex,
                    { backgroundColor: summary!.needsReview === 0 && summary!.toAdd > 0 && !importing ? theme.primary : theme.disabledText },
                  ]}
                  disabled={summary!.needsReview > 0 || summary!.toAdd === 0 || importing}
                  onPress={confirm}
                >
                  {importing ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Import {summary!.toAdd} item{summary!.toAdd === 1 ? '' : 's'}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 48 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontWeight: '700' },
  close: { fontSize: 18, fontWeight: '600', padding: 4 },
  body: { padding: 16, gap: 10 },
  help: { fontSize: 12, lineHeight: 17 },
  paste: { minHeight: 220, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14 },
  primaryBtn: { paddingVertical: 12, borderRadius: 10, alignItems: 'center', paddingHorizontal: 16 },
  primaryBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  secondaryBtn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1 },
  secondaryBtnText: { fontSize: 15, fontWeight: '600' },
  flex: { flex: 1 },
  headingRow: { marginTop: 6 },
  heading: { fontSize: 14, fontWeight: '800' },
  entry: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 6 },
  entryTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actionChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  actionText: { fontSize: 12, fontWeight: '700' },
  checkMark: { fontSize: 16 },
  nameInput: { flex: 1, borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, fontSize: 14 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  qtyInput: { width: 60, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3, fontSize: 13 },
  unitInput: { width: 60, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3, fontSize: 13 },
  intent: { flex: 1, fontSize: 11 },
  flag: { fontSize: 11, lineHeight: 15 },
  reviewed: { fontSize: 13, fontWeight: '600' },
  footer: { padding: 16, borderTopWidth: 1, gap: 8 },
  footerRow: { flexDirection: 'row', gap: 10 },
});
