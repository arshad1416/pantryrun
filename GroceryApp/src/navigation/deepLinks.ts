/**
 * Deep linking configuration for GroceryApp.
 *
 * Handles `groceryapp://invite?token=...` URLs for family invite flows,
 * and `https://groceryapp.app/invite?token=*** universal links.
 * Also supports standard navigation paths.
 *
 * Universal link setup:
 *   iOS: apple-app-site-association served at /.well-known/
 *   Android: assetlinks.json served at /.well-known/
 *   Relay server: invite-redirect.html hosted at relay domain /invite?token=...
 */

import type { LinkingOptions } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

// ─── Root Stack Param List ──────────────────────────────────────────────────

export type RootStackParamList = {
  Home: undefined;
  GroceryList: { listId: string };
  ItemEdit: { listId: string; itemId?: string };
  // token is present when opened from an invite deep link (groceryapp://invite?token=)
  Pairing: { token?: string } | undefined;
  Settings: undefined;
  Privacy: undefined;
  Recovery: { mode: 'show' | 'recover' } | undefined;
};

// ─── Deep Link Config ───────────────────────────────────────────────────────

export const linkingConfig: LinkingOptions<RootStackParamList> = {
  prefixes: ['groceryapp://', 'https://groceryapp.app'],
  config: {
    screens: {
      Home: '',
      GroceryList: 'list/:listId',
      ItemEdit: 'item/:listId/:itemId?',
      // Both the manual `pairing` path and the shared `invite?token=` links
      // open PairingScreen, which reads route.params.token and runs the full
      // join. (Previously `invite` mapped to an `Invite` route that has no
      // registered screen, so tapping a shared invite navigated nowhere.)
      Pairing: {
        path: 'pairing',
        alias: ['invite'],
        parse: {
          token: (token: string) => {
            try {
              return decodeURIComponent(token);
            } catch {
              return token;
            }
          },
        },
      },
      Settings: 'settings',
    },
  },
  // Use React Navigation's native initial-URL and URL-event handlers.
};

/**
 * Parse an invite URL and extract the token.
 *
 * Supports:
 *   - groceryapp://invite?token=<token>
 *   - https://groceryapp.app/invite?token=...
 *   - https://relay.example.com/invite?token=*** (web redirect)
 *
 * @param url - The incoming URL to parse.
 * @returns An object with the extracted token, if any.
 */
export function parseInviteUrl(url: string): { token?: string } {
  try {
    const parsed = new URL(url);

    // Match paths: /invite or host === 'invite' (for scheme URLs like groceryapp://invite)
    const isInvitePath =
      parsed.pathname === '/invite' ||
      parsed.pathname.startsWith('/invite/') ||
      parsed.host === 'invite';

    if (isInvitePath) {
      return { token: parsed.searchParams.get('token') ?? undefined };
    }

    return {};
  } catch {
    return {};
  }
}

/**
 * Construct an invite URL for sharing.
 *
 * @param token - The encoded pairing code or invite token.
 * @param useHttps - If true, returns an HTTPS universal link instead of custom scheme.
 * @returns The formatted invite URL string.
 */
export function buildInviteUrl(token: string, useHttps?: boolean): string {
  const encoded = encodeURIComponent(token);
  if (useHttps) {
    return `https://groceryapp.app/invite?token=${encoded}`;
  }
  return `groceryapp://invite?token=${encoded}`;
}

// ─── Navigation Prop Type ───────────────────────────────────────────────────

export type AppNavigationProp = NativeStackNavigationProp<RootStackParamList>;
