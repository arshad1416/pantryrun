/**
 * Family invite link generation — the single source of truth for what a
 * shareable/scannable invite contains.
 *
 * An invite must let another device (a) find the relay and (b) join the
 * family. So the payload is always `{ pairingCode, invite }`:
 *   - pairingCode: signed relay address (src/setup/self-host.ts)
 *   - invite:      Ed25519-signed one-time FamilyInviteToken validated by the
 *                  relay's /enroll endpoint (src/identity/family.ts)
 *
 * Both the Settings "Generate QR" button and the per-list "Share" action use
 * this, so they can't drift into incompatible formats (an earlier bug: the
 * list share emitted a bare {listId,familyId} blob the join flow couldn't use).
 */

import { getSettings } from '../config/settings';
import { getDeviceId, getDeviceKeypair } from './device';
import {
  createFamilyInvite,
  acceptFamilyInvite,
  getFamilyId,
} from './family';
import { getRelayToken, enrollWithRelay } from './enroll';
import { generatePairingCode } from '../setup/self-host';

export interface InviteLinkResult {
  /** JSON string embedded in the invite URL / QR. */
  token: string;
  /** The familyId this invite joins. */
  familyId: string;
  /** True if this device could not enroll with the relay (edits won't sync). */
  selfEnrollFailed: boolean;
}

/**
 * Build the relay base URL with exactly one port. `settings.relayUrl` may
 * already contain a port (it's saved verbatim from scanned pairing codes), so
 * a naive `${url}:${port}` can produce `ws://host:8080:8080`.
 */
function relayBaseWithPort(relayUrl: string, relayPort: number): string {
  const withoutScheme = relayUrl.replace(/^[a-z]+:\/\//i, '');
  const hasPort = /:\d+(\/|$)/.test(withoutScheme);
  return hasPort ? relayUrl : `${relayUrl}:${relayPort}`;
}

/**
 * Create a shareable family invite for the current device's family.
 *
 * - Reuses this device's family, or founds one on the first invite.
 * - Ensures THIS device is enrolled with the relay (so the inviter also
 *   syncs), using a separate single-use invite.
 * - Returns the token to embed and whether self-enrollment succeeded.
 *
 * Requires a configured relay (`settings.relayUrl`). Throws otherwise.
 */
export async function createFamilyInviteLink(): Promise<InviteLinkResult> {
  const settings = getSettings();
  if (!settings.relayUrl) {
    throw new Error(
      'Family sharing needs a sync server (a small, free server you or a tech-savvy family member run at home). ' +
        'Set one up under Settings → Pair a device, then invite the rest of your family.',
    );
  }

  const deviceId = getDeviceId();
  const keypair = getDeviceKeypair();
  const relayBase = relayBaseWithPort(settings.relayUrl, settings.relayPort || 8080);

  const existingFamilyId = await getFamilyId();
  const invite = await createFamilyInvite(keypair, undefined, existingFamilyId ?? undefined);
  if (!existingFamilyId) {
    await acceptFamilyInvite(invite, keypair);
  }

  // Self-enroll so the inviter holds a relayToken too (invites are one-time,
  // so the inviter can't reuse the invitee's).
  let selfEnrollFailed = false;
  try {
    if (!(await getRelayToken())) {
      const selfInvite = await createFamilyInvite(keypair, undefined, invite.familyId);
      const httpBase = relayBase.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
      await enrollWithRelay(httpBase, deviceId, JSON.stringify(selfInvite), keypair);
      const { bootstrapSync } = await import('../sync/bootstrap');
      bootstrapSync().catch(() => {});
    }
  } catch (err) {
    console.warn('[invite-link] Self-enrollment failed (invite still generated):', err);
    selfEnrollFailed = true;
  }

  const pairingCode = await generatePairingCode(deviceId, invite.familyId, relayBase);
  const token = JSON.stringify({ pairingCode, invite });
  return { token, familyId: invite.familyId, selfEnrollFailed };
}

/** Build the deep-link URL that wraps an invite token. */
export function inviteTokenToUrl(token: string): string {
  return `groceryapp://invite?token=${encodeURIComponent(token)}`;
}
