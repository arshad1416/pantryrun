/**
 * NotificationManager — core orchestrator for the family notification system.
 *
 * Responsibilities:
 *  - Encrypt notification payloads (XChaCha20-Poly1305, same as Yjs updates)
 *  - Send encrypted notifications via WebSocket relay
 *  - Receive and decrypt incoming notifications
 *  - Display local notifications via expo-notifications
 *  - Manage badge count
 *
 * Notifications are best-effort: if offline, they're dropped silently.
 * The actual data mutation is persisted via Yjs CRDT sync — notifications
 * are supplementary UI feedback only.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getDeviceId } from '../identity/device';
import { getDatabase } from '../storage/database';
import type { NotificationPayload, NotificationRecord, NotificationEventType } from '../types/notifications';
import type { EncryptedData } from '../types';

// ─── Lazy sodium import ──────────────────────────────────────────────────────
let sodium: any = null;

async function getSodium(): Promise<any> {
  if (!sodium) {
    const mod = await import('react-native-libsodium');
    sodium = mod.default;
  }
  return sodium;
}

/**
 * XChaCha20-Poly1305 authentication tag length.
 *
 * Hardcoded for the same reason as crypto/index.ts and sync/y-websocket.ts:
 * react-native-libsodium's native surface never declares
 * crypto_aead_xchacha20poly1305_ietf_ABYTES, so reading it gives undefined on
 * device and the envelope splits at NaN — ciphertext comes out empty with
 * cipher||tag in the tag field. The encrypt/decrypt pair here re-concatenates,
 * so nothing broke visibly, but the envelope was mislabelled on every phone.
 */
const ABYTES = 16;

// ─── Notification Channel (Android) ──────────────────────────────────────────

const NOTIFICATION_CHANNEL_ID = 'pantryrun-family';

async function ensureNotificationChannel(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
      name: 'Family Updates',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#10B981',
      sound: 'default',
    });
  }
}

// ─── Permissions ──────────────────────────────────────────────────────────────

export async function requestNotificationPermissions(): Promise<boolean> {
  await ensureNotificationChannel();

  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

// ─── Badge Management ─────────────────────────────────────────────────────────

let unreadCount = 0;

/** Initialize badge count from persisted state (call on app start) */
export async function initBadgeCount(count: number): Promise<void> {
  unreadCount = count;
  await Notifications.setBadgeCountAsync(count);
}

/** Increment badge and persist */
export async function incrementBadge(): Promise<void> {
  unreadCount++;
  await Notifications.setBadgeCountAsync(unreadCount);
}

/** Clear badge (mark all as read) */
export async function clearBadge(): Promise<void> {
  unreadCount = 0;
  await Notifications.setBadgeCountAsync(0);
}

/** Get current unread count */
export function getUnreadCount(): number {
  return unreadCount;
}

// ─── Send Notification ────────────────────────────────────────────────────────

/**
 * Send a family notification to all paired devices.
 * Called after a local item mutation (add, check, uncheck, delete).
 *
 * Does NOT show a local notification on the sender's device.
 */
export async function sendFamilyNotification(
  eventType: NotificationEventType,
  listId: string,
  listName: string,
  itemId: string,
  itemName: string,
  itemCategory: string,
  encryptionKey: Uint8Array,
): Promise<void> {
  try {
    const deviceId = getDeviceId();
    const s = await getSodium();

    const payload: NotificationPayload = {
      id: await generateNotificationId(),
      eventType,
      timestamp: Date.now(),
      senderDeviceId: deviceId,
      listId,
      listName,
      itemId,
      itemName,
      itemCategory,
    };

    // Encrypt the payload using the same scheme as Yjs updates
    const encrypted = await encryptNotificationPayload(payload, listId, encryptionKey);

    // Send via the sync manager's WebSocket client
    const { syncManager } = await import('../sync/sync-manager');
    syncManager.sendNotification(listId, encrypted);
  } catch (err) {
    // Notifications are best-effort — log and move on
    console.warn('[NotificationManager] Failed to send notification:', err);
  }
}

// ─── Receive & Display Notification ───────────────────────────────────────────

/**
 * Handle an incoming notification from the relay server.
 * Decrypt, persist locally, show system notification, increment badge.
 */
export async function handleIncomingNotification(
  listId: string,
  encryptedPayload: EncryptedData,
  encryptionKey: Uint8Array,
): Promise<NotificationRecord | null> {
  try {
    const payload = await decryptNotificationPayload(encryptedPayload, listId, encryptionKey);

    // Don't show notification for our own actions
    if (payload.senderDeviceId === getDeviceId()) return null;

    // Build display text
    const { title, body } = buildNotificationText(payload);

    // Persist to local DB
    const record: NotificationRecord = {
      ...payload,
      isRead: false,
    };
    await saveNotificationToDB(record);

    // Show system notification (notification drawer / notification center)
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: {
          notificationId: payload.id,
          listId: payload.listId,
          itemId: payload.itemId,
          eventType: payload.eventType,
        },
        sound: 'default',
        ...(Platform.OS === 'android' && {
          channelId: NOTIFICATION_CHANNEL_ID,
        }),
      },
      trigger: null, // immediate
    });

    // Increment badge count
    await incrementBadge();

    // Update the Zustand notification store
    try {
      const { useNotificationStore } = await import('../state/useNotificationStore');
      useNotificationStore.getState().onNotificationReceived(record);
    } catch {
      // Store may not be initialized yet — non-critical
    }

    return record;
  } catch (err) {
    console.warn('[NotificationManager] Failed to handle incoming notification:', err);
    return null;
  }
}

// ─── Display Text Builder ─────────────────────────────────────────────────────

function buildNotificationText(payload: NotificationPayload): { title: string; body: string } {
  const { eventType, itemName, listName } = payload;
  const truncatedItem = itemName.length > 50 ? itemName.slice(0, 50) + '…' : itemName;
  const truncatedList = listName.length > 30 ? listName.slice(0, 30) + '…' : listName;

  switch (eventType) {
    case 'item_added':
      return {
        title: 'Item Added',
        body: `"${truncatedItem}" was added to ${truncatedList}`,
      };
    case 'item_checked':
      return {
        title: 'Item Purchased',
        body: `"${truncatedItem}" was checked off in ${truncatedList}`,
      };
    case 'item_unchecked':
      return {
        title: 'Item Unchecked',
        body: `"${truncatedItem}" was unchecked in ${truncatedList}`,
      };
    case 'item_deleted':
      return {
        title: 'Item Removed',
        body: `"${truncatedItem}" was removed from ${truncatedList}`,
      };
    case 'list_deleted':
      return {
        title: 'List Deleted',
        body: `"${truncatedList}" was deleted`,
      };
    default:
      return {
        title: 'List Updated',
        body: `${truncatedList} has been updated`,
      };
  }
}

// ─── Encryption Helpers ──────────────────────────────────────────────────────

async function encryptNotificationPayload(
  payload: NotificationPayload,
  listId: string,
  key: Uint8Array,
): Promise<EncryptedData> {
  const s = await getSodium();
  const serialized = JSON.stringify(payload);
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  // The native binding accepts only a string AAD; libsodium UTF-8 encodes it,
  // so the authenticated bytes match the old TextEncoder output.
  const additionalData = listId;
  const plaintext = new TextEncoder().encode(serialized);
  const cipherWithTag = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext, additionalData, null, nonce, key,
  );
  return {
    ciphertext: s.to_base64(cipherWithTag.slice(0, cipherWithTag.length - ABYTES), s.base64_variants.ORIGINAL),
    iv: s.to_base64(nonce, s.base64_variants.ORIGINAL),
    tag: s.to_base64(cipherWithTag.slice(cipherWithTag.length - ABYTES), s.base64_variants.ORIGINAL),
  };
}

async function decryptNotificationPayload(
  data: EncryptedData,
  listId: string,
  key: Uint8Array,
): Promise<NotificationPayload> {
  const s = await getSodium();
  const nonce = s.from_base64(data.iv, s.base64_variants.ORIGINAL);
  const tag = s.from_base64(data.tag, s.base64_variants.ORIGINAL);
  const ciphertext = s.from_base64(data.ciphertext, s.base64_variants.ORIGINAL);
  const cipherWithTag = new Uint8Array(ciphertext.length + tag.length);
  cipherWithTag.set(ciphertext);
  cipherWithTag.set(tag, ciphertext.length);
  // Native binding: string AAD only (see encryptNotificationPayload).
  const additionalData = listId;
  const plaintext = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, cipherWithTag, additionalData, nonce, key,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as NotificationPayload;
}

// ─── Local Persistence ────────────────────────────────────────────────────────

async function saveNotificationToDB(record: NotificationRecord): Promise<void> {
  const { saveNotification } = await import('./NotificationRepository');
  await saveNotification(record);
}

async function generateNotificationId(): Promise<string> {
  const s = await getSodium();
  return s.to_base64(
    s.randombytes_buf(16),
    s.base64_variants.ORIGINAL,
  );
}
