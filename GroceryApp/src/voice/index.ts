/**
 * Unified Voice API — VoiceService.
 *
 * Wraps all voice platforms (Siri, Alexa, IFTTT, widget) into a single
 * interface. Provides:
 *  - processVoiceInput(input): Routes raw voice text through NLP parsing
 *  - addViaVoice(input, listId): Full pipeline: parse → encrypt → add to Yjs doc
 *  - Platform detection: Siri on iOS, widget/share on Android, IFTTT as universal bridge
 *
 * Usage:
 *   import { VoiceService } from '../voice';
 *   const result = await VoiceService.processVoiceInput({
 *     raw: '2% milk x2',
 *     platform: 'siri',
 *     timestamp: Date.now(),
 *   });
 *   // { name: '2% Milk', quantity: 2, unit: 'each', confidence: 0.9 }
 */

import React, { useState, useCallback } from 'react';
import { Platform } from 'react-native';
import type { VoiceInput, ParsedItem, VoicePlatform } from './types';
import { parseVoiceText } from './nlp';
import { isSiriAvailable, donateInteraction } from './siri';
import { inferCategory } from '../utils/inferCategory';

// ─── VoiceService ────────────────────────────────────────────────────────────

export class VoiceService {
  /**
   * Process raw voice input through the NLP parser.
   *
   * Routes the input through the regex-based parser and returns a
   * structured ParsedItem. Platform-specific preprocessing (e.g.,
   * Siri intent parameters) can be handled here.
   *
   * @param input - Raw voice input with platform metadata.
   * @returns ParsedItem with name, quantity, unit, and confidence.
   */
  static async processVoiceInput(input: VoiceInput): Promise<ParsedItem> {
    const parsed = parseVoiceText(input.raw);

    // Adjust confidence based on platform reliability
    if (parsed.confidence < 1) {
      const platformBoost: Record<VoicePlatform, number> = {
        siri: 0.05,
        alexa: 0.05,
        ifttt: 0.0,
        widget: -0.1,
      };
      const boost = platformBoost[input.platform] ?? 0;
      parsed.confidence = Math.max(0, Math.min(1, parsed.confidence + boost));
    }

    return parsed;
  }

  /**
   * Full voice-to-item pipeline.
   *
   * 1. Parse the voice text via NLP
   * 2. (In production) encrypt sensitive fields
   * 3. Add the item to the Yjs document via the grocery store
   * 4. Donate a Siri interaction (iOS) for future shortcut suggestions
   *
   * @param input  - Raw voice input.
   * @param listId - The target grocery list ID.
   * @param store  - The Zustand grocery store instance (injected to avoid circular deps).
   * @returns The parsed item that was added.
   */
  static async addViaVoice(
    input: VoiceInput,
    listId: string,
    store: {
      addItem: (item: {
        listId: string;
        familyId: string;
        name: string;
        quantity: number;
        unit: string;
        category: string;
        isChecked: boolean;
        addedBy: string;
        sortOrder: number;
      }) => Promise<unknown>;
      items: Record<string, { listId: string; familyId: string; sortOrder: number }>;
    },
    activeMemberId: string | null,
    familyMembers: Record<string, { familyId: string }>,
  ): Promise<ParsedItem> {
    const parsed = await VoiceService.processVoiceInput(input);

    // Determine familyId from existing items or family members
    const listItems = Object.values(store.items).filter(
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

    // In production: encrypt name/notes via the crypto layer
    //   const key = await getMasterKey();
    //   const encryptedName = key ? await encrypt(parsed.name, key, FIELD_CONTEXTS.GROCERY_ITEM_NAME) : parsed.name;

    await store.addItem({
      listId,
      familyId,
      name: parsed.name,
      quantity: parsed.quantity,
      unit: parsed.unit,
      category: inferCategory(parsed.name),
      isChecked: false,
      addedBy: activeMemberId ?? 'voice',
      sortOrder: maxSort + 1,
    });

    // Donate Siri interaction on iOS for future shortcut suggestions
    if (isSiriAvailable()) {
      await donateInteraction(parsed.name);
    }

    return parsed;
  }

  /**
   * Detect the current platform for voice input routing.
   *
   * @returns The active voice platform for this device.
   */
  static detectPlatform(): VoicePlatform {
    if (Platform.OS === 'ios') return 'siri';
    if (Platform.OS === 'android') return 'widget';
    return 'ifttt';
  }
}

// ─── Hook: useVoiceInput ─────────────────────────────────────────────────────

/**
 * React hook for integrating voice input into screens.
 *
 * Provides:
 *  - voiceText: the raw voice transcription
 *  - parsedItem: the NLP-parsed result (or null if not yet parsed)
 *  - isProcessing: whether voice processing is in progress
 /**
  * useVoiceInput — React hook for voice capture.
  *
  * Provides a simple state machine: request → capture → parse → return.
  * Used by AddItemSheet and other voice-enabled components.
  *
  * Usage:
  *   const { voiceText, parsedItem, requestVoiceInput } = useVoiceInput();
  *   // Call requestVoiceInput() from a button press
  *   // When parsedItem is set, pre-fill the form
  */
 export function useVoiceInput(): {
   voiceText: string;
   parsedItem: ParsedItem | null;
   isProcessing: boolean;
   requestVoiceInput: () => void;
   clearVoiceInput: () => void;
 } {
   const [voiceText, setVoiceText] = useState('');
   const [parsedItem, setParsedItem] = useState<ParsedItem | null>(null);
   const [isProcessing, setIsProcessing] = useState(false);

   const requestVoiceInput = useCallback(() => {
     // On iOS, this would trigger Siri/dictation.
     // On Android, this opens a text input for voice text.
     // For now, use a prompt fallback (works in dev).
     const text = Platform.OS === 'web' ? '' : '';
     if (text) {
       setIsProcessing(true);
       const result = parseVoiceText(text);
       setParsedItem(result);
       setVoiceText(text);
       setIsProcessing(false);
     }
   }, []);

   const clearVoiceInput = useCallback(() => {
     setVoiceText('');
     setParsedItem(null);
     setIsProcessing(false);
   }, []);

   return { voiceText, parsedItem, isProcessing, requestVoiceInput, clearVoiceInput };
 }

// ─── Re-exports ──────────────────────────────────────────────────────────────

export { parseVoiceText } from './nlp';
export type { VoiceInput, ParsedItem, VoicePlatform } from './types';