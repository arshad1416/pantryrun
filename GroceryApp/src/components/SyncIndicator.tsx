/**
 * SyncIndicator — Shows sync state (syncing/error/offline/synced) in the header.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { SyncState } from '../types';
import { useSyncStore, syncIndicatorStatus } from '../state/useSyncStore';
import { useActiveTheme } from '../state/useThemeStore';
import { themeColors } from './groceryTheme';

export default function SyncIndicator({listId}: {listId?: string}) {
  const connectionState = useSyncStore((s) => s.connectionState);
  const syncState: SyncState = useSyncStore((s) => s.syncState);
  const lastSyncedAt: number | null = useSyncStore((s) => s.lastSyncedAt);
  const errorMessage: string | null = useSyncStore((s) => s.error);
  const undecryptableLists = useSyncStore((s) => s.undecryptableLists);
  const recoveryPendingLists = useSyncStore((s) => s.recoveryPendingLists);
  const persistenceError = useSyncStore((s) => s.persistenceError);
  const storageRecoveryError = useSyncStore((s) => s.storageRecoveryError);
  const activeTheme = useActiveTheme();
  const theme = activeTheme === 'dark' ? themeColors.dark : themeColors.light;

  const { label, color } = syncIndicatorStatus({
    activeListId: listId,
    connectionState,
    syncState,
    error: errorMessage,
    undecryptableLists,
    recoveryPendingLists,
    persistenceError,
    storageRecoveryError,
  });

  // Don't show a "last synced" time when nothing has ever synced — nor when
  // the data cannot be read, where a fresh timestamp reads as reassurance.
  const timeLabel =
    lastSyncedAt && !persistenceError && !storageRecoveryError && syncState !== 'not_configured' && undecryptableLists.length === 0 && (!listId ? recoveryPendingLists.length === 0 : !recoveryPendingLists.includes(listId))
      ? new Date(lastSyncedAt).toLocaleTimeString()
      : '';

  return (
    <View style={styles.syncIndicator}>
      <View style={[styles.syncDot, { backgroundColor: color }]} />
      <Text style={[styles.syncText, { color: theme.secondaryText }]}>
        {label}
        {timeLabel ? ` · ${timeLabel}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  syncIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  syncDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  syncText: {
    fontSize: 11,
    color: '#999',
  },
});
