/**
 * ChecklistImportSheet — paste a checklist, review it, then apply.
 *
 * Step 1: paste (e.g. Google Keep's "Copy" output, a Markdown task list,
 * or plain lines). Step 2: a preview of every pasted line — headings,
 * items with quantity, checked state, notes and section, and anything
 * that needs a decision (ambiguous headings, duplicates, items already on
 * the list, conflicting variants, assumed or invalid quantities).
 *
 * Nothing touches the list until "Add N items". Cancel at either step
 * leaves the list unchanged. Applying adds exactly the previewed items;
 * if any add fails, the ones already added are removed again so there is
 * no partial import. After a successful import the person can undo it.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useGroceryStore } from '../state/useGroceryStore';
import { useFamilyStore } from '../state/useFamilyStore';
import { useActiveTheme } from '../state/useThemeStore';
import {
  buildImport,
  describeIssue,
  emptyDecisions,
  parseChecklist,
  willImport,
  type ImportDecisions,
  type ParsedLine,
} from '../services/checklistImport';
import { themeColors } from './groceryTheme';

interface ChecklistImportSheetProps {
  visible: boolean;
  listId: string;
  onClose: () => void;
}

function toggle(set: Set<number>, n: number): Set<number> {
  const next = new Set(set);
  if (next.has(n)) next.delete(n);
  else next.add(n);
  return next;
}

function quantityLabel(line: ParsedLine): string {
  if (line.quantity === null) return 'qty ?';
  if (line.unit) return `${line.quantity} ${line.unit}`;
  return line.issues.includes('quantity_assumed') ? '×1 (assumed)' : `×${line.quantity}`;
}

export default function ChecklistImportSheet({ visible, listId, onClose }: ChecklistImportSheetProps) {
  const theme = themeColors[useActiveTheme()];
  const items = useGroceryStore((s) => s.items);
  const addItem = useGroceryStore((s) => s.addItem);
  const deleteItem = useGroceryStore((s) => s.deleteItem);
  const activeMemberId = useFamilyStore((s) => s.activeMemberId);
  const familyMembers = useFamilyStore((s) => s.members);

  const [text, setText] = useState('');
  const [lines, setLines] = useState<ParsedLine[] | null>(null);
  const [decisions, setDecisions] = useState<ImportDecisions>(emptyDecisions);
  const [applying, setApplying] = useState(false);

  const listItems = useMemo(
    () => Object.values(items).filter((i) => i.listId === listId && !i.isDeleted),
    [items, listId],
  );

  const reset = useCallback(() => {
    setText('');
    setLines(null);
    setDecisions(emptyDecisions());
    setApplying(false);
  }, []);

  const handleCancel = useCallback(() => {
    if (applying) return;
    reset();
    onClose();
  }, [applying, reset, onClose]);

  const handlePreview = useCallback(() => {
    setLines(parseChecklist(text, listItems));
    setDecisions(emptyDecisions());
  }, [text, listItems]);

  const toImport = useMemo(() => (lines ? buildImport(lines, decisions) : []), [lines, decisions]);

  const handleApply = useCallback(async () => {
    if (!lines || toImport.length === 0 || applying) return;
    setApplying(true);
    const familyId = listItems[0]?.familyId ?? Object.values(familyMembers)[0]?.familyId ?? '';
    let sortOrder = listItems.reduce((m, i) => Math.max(m, i.sortOrder), 0);
    const created: string[] = [];
    try {
      for (const it of toImport) {
        const added = await addItem({
          listId,
          familyId,
          name: it.name,
          quantity: it.quantity,
          unit: it.unit,
          category: it.category,
          isChecked: it.isChecked,
          addedBy: activeMemberId ?? 'import',
          sortOrder: ++sortOrder,
          ...(it.notes ? { notes: it.notes } : {}),
        });
        created.push(added.id);
      }
    } catch (err) {
      // No partial import: remove what this attempt added.
      for (const id of created) await deleteItem(id).catch(() => {});
      setApplying(false);
      Alert.alert('Import failed', `Nothing was added. ${err instanceof Error ? err.message : ''}`.trim());
      return;
    }
    reset();
    onClose();
    Alert.alert('Checklist imported', `Added ${created.length} item${created.length === 1 ? '' : 's'}.`, [
      {
        text: 'Undo',
        style: 'destructive',
        onPress: () => {
          for (const id of created) deleteItem(id).catch(() => {});
        },
      },
      { text: 'OK' },
    ]);
  }, [lines, toImport, applying, listItems, familyMembers, addItem, listId, activeMemberId, deleteItem, reset, onClose]);

  const counts = useMemo(() => {
    if (!lines) return null;
    const itemLines = lines.filter((l) => l.kind === 'item');
    return {
      headings: lines.filter((l) => l.kind === 'heading').length,
      items: itemLines.length,
      review: lines.filter((l) => l.issues.some((i) => i !== 'quantity_assumed')).length,
    };
  }, [lines]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleCancel}>
      <KeyboardAvoidingView
        style={[styles.overlay, { backgroundColor: theme.overlay }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.sheet, { backgroundColor: theme.cardBg }]}>
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            <Text style={[styles.title, { color: theme.text }]}>
              {lines ? 'Review import' : 'Paste a checklist'}
            </Text>
            <TouchableOpacity onPress={handleCancel} accessibilityRole="button" accessibilityLabel="Cancel import">
              <Text style={[styles.headerAction, { color: theme.secondaryText }]}>Cancel</Text>
            </TouchableOpacity>
          </View>

          {!lines ? (
            <View style={styles.body}>
              <Text style={[styles.hint, { color: theme.secondaryText }]}>
                Paste a list copied from Google Keep (or any checklist). Headings like
                "Costco:" become sections, not items. You'll review everything before
                anything is added.
              </Text>
              <TextInput
                style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
                value={text}
                onChangeText={setText}
                multiline
                placeholder={'☐ LF milk 3L (3.25% only)\n☐ ketchup - sale only\nCostco:\n☐ gummies'}
                placeholderTextColor={theme.secondaryText}
                autoCorrect={false}
                accessibilityLabel="Checklist text"
              />
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: text.trim() ? theme.primary : theme.inactiveBg }]}
                onPress={handlePreview}
                disabled={!text.trim()}
                accessibilityRole="button"
              >
                <Text style={styles.primaryBtnText}>Preview</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {counts && (
                <Text style={[styles.summary, { color: theme.secondaryText }]}>
                  {counts.items} item lines · {counts.headings} heading{counts.headings === 1 ? '' : 's'}
                  {counts.review > 0 ? ` · ${counts.review} to review` : ''}
                </Text>
              )}
              <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                {lines.map((line) => {
                  const included = willImport(line, decisions);
                  const isHeading = line.kind === 'heading';
                  const ambiguous = line.issues.includes('ambiguous_heading');
                  const duplicate = line.duplicateOf !== undefined;
                  const blocked = line.issues.includes('quantity_invalid') || line.issues.includes('empty_name');
                  return (
                    <View key={line.lineNo} style={[styles.row, { borderBottomColor: theme.divider }]}>
                      <View style={styles.rowMain}>
                        {isHeading && !included ? (
                          <Text style={[styles.heading, { color: theme.primary }]}>▸ {line.name}</Text>
                        ) : (
                          <Text style={[styles.itemName, { color: included ? theme.text : theme.secondaryText }]}>
                            {included ? '＋ ' : '– '}
                            {line.checked ? '☑ ' : ''}
                            {line.name || '(no name)'}
                            <Text style={{ color: theme.secondaryText }}>  {quantityLabel(line)}</Text>
                          </Text>
                        )}
                        {line.notes.length > 0 && (
                          <Text style={[styles.meta, { color: theme.secondaryText }]}>Note: {line.notes.join('; ')}</Text>
                        )}
                        {!isHeading && line.section && (
                          <Text style={[styles.meta, { color: theme.secondaryText }]}>Section: {line.section}</Text>
                        )}
                        {line.issues.map((issue) => (
                          <Text
                            key={issue}
                            style={[styles.meta, { color: issue === 'quantity_assumed' ? theme.secondaryText : theme.unassignedText }]}
                          >
                            {issue === 'duplicate_in_paste' && line.duplicateOf !== 'list'
                              ? `duplicate of line ${line.duplicateOf}`
                              : describeIssue(issue)}
                          </Text>
                        ))}
                        <Text style={[styles.source, { color: theme.secondaryText }]} numberOfLines={1}>
                          {line.lineNo}: {line.source.trim()}
                        </Text>
                      </View>
                      <View style={styles.rowActions}>
                        {ambiguous && (
                          <TouchableOpacity
                            style={[styles.chip, { borderColor: theme.border }]}
                            onPress={() => setDecisions((d) => ({ ...d, headingAsItem: toggle(d.headingAsItem, line.lineNo) }))}
                          >
                            <Text style={[styles.chipText, { color: theme.text }]}>{included ? 'Make heading' : 'Make item'}</Text>
                          </TouchableOpacity>
                        )}
                        {!isHeading && duplicate && !blocked && (
                          <TouchableOpacity
                            style={[styles.chip, { borderColor: theme.border }]}
                            onPress={() => setDecisions((d) => ({ ...d, addDuplicate: toggle(d.addDuplicate, line.lineNo) }))}
                          >
                            <Text style={[styles.chipText, { color: theme.text }]}>{included ? 'Skip' : 'Add anyway'}</Text>
                          </TouchableOpacity>
                        )}
                        {!isHeading && !duplicate && !blocked && (
                          <TouchableOpacity
                            style={[styles.chip, { borderColor: theme.border }]}
                            onPress={() => setDecisions((d) => ({ ...d, excluded: toggle(d.excluded, line.lineNo) }))}
                          >
                            <Text style={[styles.chipText, { color: theme.text }]}>{included ? 'Exclude' : 'Include'}</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
              <View style={[styles.footer, { borderTopColor: theme.border }]}>
                <TouchableOpacity
                  style={[styles.secondaryBtn, { borderColor: theme.border }]}
                  onPress={() => setLines(null)}
                  disabled={applying}
                >
                  <Text style={[styles.secondaryBtnText, { color: theme.text }]}>Edit text</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryBtn, styles.flex, { backgroundColor: toImport.length > 0 && !applying ? theme.primary : theme.inactiveBg }]}
                  onPress={handleApply}
                  disabled={toImport.length === 0 || applying}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryBtnText}>
                    {applying ? 'Adding…' : `Add ${toImport.length} item${toImport.length === 1 ? '' : 's'}`}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '92%', borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontWeight: '700' },
  headerAction: { fontSize: 15, fontWeight: '600' },
  body: { padding: 16, gap: 12 },
  hint: { fontSize: 13, lineHeight: 18 },
  input: { minHeight: 180, maxHeight: 320, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 14, textAlignVertical: 'top' },
  summary: { fontSize: 13, paddingHorizontal: 20, paddingTop: 10 },
  list: { flexGrow: 0 },
  listContent: { paddingHorizontal: 16, paddingBottom: 12 },
  row: { flexDirection: 'row', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  rowMain: { flex: 1 },
  rowActions: { justifyContent: 'center', gap: 6 },
  heading: { fontSize: 14, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  itemName: { fontSize: 15, fontWeight: '600' },
  meta: { fontSize: 12, marginTop: 2 },
  source: { fontSize: 11, marginTop: 3, fontStyle: 'italic' },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontSize: 12, fontWeight: '600' },
  footer: { flexDirection: 'row', gap: 10, padding: 16, borderTopWidth: 1 },
  flex: { flex: 1 },
  primaryBtn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, alignItems: 'center' },
  primaryBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  secondaryBtn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, alignItems: 'center' },
  secondaryBtnText: { fontSize: 15, fontWeight: '600' },
});
