/**
 * Invite URL parsing — pure helpers shared by the QR scanner and tests.
 *
 * Invite links look like `groceryapp://invite?token=<urlencoded JSON>` or
 * `https://<host>/invite?token=...`. Old builds generated a misspelled
 * `grocceryapp://` scheme; scanning still accepts it (the OS-level deep-link
 * registration never did — that's why shared links from old builds were dead).
 */

export const INVITE_URL_PREFIX = 'groceryapp://invite?token=';
export const LEGACY_INVITE_URL_PREFIX = 'grocceryapp://invite?token=';
/** Registered alongside groceryapp:// so links in the new name also open the app. */
export const PANTRYRUN_INVITE_URL_PREFIX = 'pantryrun://invite?token=';

/**
 * Parse an invite URL from scanned QR data (or a pasted link).
 * Returns the decoded token payload, or null if not a valid invite URL.
 */
export function parseInviteUrl(data: string): string | null {
  const decode = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  if (data.startsWith(INVITE_URL_PREFIX)) {
    return decode(data.substring(INVITE_URL_PREFIX.length));
  }
  if (data.startsWith(LEGACY_INVITE_URL_PREFIX)) {
    return decode(data.substring(LEGACY_INVITE_URL_PREFIX.length));
  }
  if (data.startsWith(PANTRYRUN_INVITE_URL_PREFIX)) {
    return decode(data.substring(PANTRYRUN_INVITE_URL_PREFIX.length));
  }
  // Also support https:// variants
  const httpsMatch = data.match(/^https:\/\/[^/]+\/invite\?token=([^&\s]+)/);
  if (httpsMatch) {
    return decode(httpsMatch[1]);
  }
  return null;
}
