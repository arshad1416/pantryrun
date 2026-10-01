/**
 * A ciphertext that fails its authentication tag must reach the user.
 *
 * Poly1305 rejects with probability ~1-2^-128 unless the key is genuinely
 * wrong, so an AEAD failure means one thing in practice: this device's key is
 * not the key the data was written under. It is the single sync fault that
 * gets WORSE while unnoticed — the device keeps encrypting local edits under
 * the wrong key and pushing them into the family's stream, where the relay
 * retains and replays them for 30 days.
 *
 * Three separate things conspired to hide it:
 *
 *   1. y-websocket's 'update' case had no local try/catch, so the throw
 *      unwound to the generic onmessage handler and became a console.warn.
 *   2. bootstrap's onSyncError wrote `error` but not `syncState`, and
 *      SyncIndicator only renders `error` when syncState === 'error'. So even
 *      errors that DID reach the store were never displayed.
 *   3. setConnectionState derives syncState from the socket, so anything
 *      written there is erased by the next successful connect — and a
 *      wrong-key device connects perfectly.
 *
 * Net effect: the indicator said "Synced" while every incoming message was
 * discarded. These tests assert the RENDERED label, not merely that a store
 * field moved — a store-only assertion is exactly what passes while the user
 * still sees "Synced".
 *
 * Sibling: sync-failure-surfacing.test.ts covers the OUTBOUND persistence
 * failures (M6). This file covers the inbound decrypt path.
 *
 * Run: npx jest __tests__/decrypt-failure-surfacing.test.ts
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import sodium from 'libsodium-wrappers';

import { YjsWebSocketClient } from '../src/sync/y-websocket';
import { useSyncStore, syncIndicatorStatus } from '../src/state/useSyncStore';
import { DecryptFailureError, encrypt, initCrypto } from '../src/crypto';
import { decryptField } from '../src/storage/hydrate';

const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);

/** An envelope this client cannot possibly authenticate. */
const garbledEnvelope = () => ({
  ciphertext: sodium.to_base64(new Uint8Array(48).fill(9), sodium.base64_variants.ORIGINAL),
  iv: sodium.to_base64(new Uint8Array(24).fill(3), sodium.base64_variants.ORIGINAL),
  tag: sodium.to_base64(new Uint8Array(16).fill(7), sodium.base64_variants.ORIGINAL),
});

/** A real, authenticating update envelope for the client's own key. */
async function realUpdateEnvelope(listId: string) {
  const nonce = sodium.randombytes_buf(24);
  const plaintext = new Uint8Array([1, 2, 3]);
  const combined = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    new TextEncoder().encode(listId),
    null,
    nonce,
    KEY_A,
  );
  const ct = combined.slice(0, combined.length - 16);
  const tag = combined.slice(combined.length - 16);
  return {
    ciphertext: sodium.to_base64(ct, sodium.base64_variants.ORIGINAL),
    iv: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    tag: sodium.to_base64(tag, sodium.base64_variants.ORIGINAL),
  };
}

async function makeClient() {
  const client = new YjsWebSocketClient({
    url: 'ws://localhost:19998',
    familyId: 'fam',
    deviceId: 'dev',
    encryptionKey: KEY_A,
  });
  const errors: Error[] = [];
  const applied: string[] = [];
  client.onError = (e) => errors.push(e);
  client.onRemoteUpdate = (listId) => applied.push(listId);
  // handleMessage is private; driving it directly is the point — it is the
  // function the socket calls, and there is no relay in this suite.
  // MUST init: getSodium() populates the lazy binding needed for real decrypts.
  // Only replace connect: these tests drive handleMessage directly and must
  // never open a real socket. Node 22's built-in WebSocket otherwise reports a
  // late connection failure to the deliberately throwing onError listener,
  // crashing Jest after the assertions pass. Node 20 has no global WebSocket.
  jest.spyOn(client, 'connect').mockImplementation(() => {});
  await client.init();

  const deliver = (msg: unknown) => (client as any).handleMessage(msg);
  return { client, errors, applied, deliver };
}

beforeEach(async () => {
  await sodium.ready;
  await initCrypto();
  useSyncStore.setState({
    syncState: 'not_configured',
    connectionState: 'disconnected',
    error: null,
    undecryptableLists: [],
    lastSyncedAt: null,
  });
});

describe('an undecryptable update is reported, not discarded', () => {
  it('reports a DecryptFailureError and does not apply the update', async () => {
    const { errors, applied, deliver } = await makeClient();

    await deliver({ type: 'update', listId: 'list-1', payload: garbledEnvelope() });

    expect(applied).toEqual([]); // nothing was applied
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(DecryptFailureError);
    expect((errors[0] as DecryptFailureError).context).toBe('list-1');
  });

  it('reports an undecryptable sync_request too', async () => {
    const { client, errors, deliver } = await makeClient();
    let answered = false;
    client.onSyncRequest = () => {
      answered = true;
    };

    await deliver({ type: 'sync_request', listId: 'list-2', payload: garbledEnvelope() });

    expect(answered).toBe(false);
    expect(errors[0]).toBeInstanceOf(DecryptFailureError);
  });

  it('does not throw out of handleMessage — one bad list must not kill the socket', async () => {
    const { deliver, applied } = await makeClient();

    await expect(
      deliver({ type: 'update', listId: 'bad', payload: garbledEnvelope() }),
    ).resolves.not.toThrow();

    // A good message after a bad one is still processed.
    await deliver({ type: 'ack' });
    expect(applied).toEqual([]);
  });
});

describe('reporting is throttled, because the relay replays 30 days of updates', () => {
  it('reports a given list once, however many messages fail', async () => {
    const { errors, deliver } = await makeClient();

    for (let i = 0; i < 50; i++) {
      await deliver({ type: 'update', listId: 'list-1', payload: garbledEnvelope() });
    }

    // Unthrottled this is 50 store writes and 50 console lines per reconnect,
    // which is its own outage.
    expect(errors).toHaveLength(1);
  });

  it('still reports a DIFFERENT list', async () => {
    const { errors, deliver } = await makeClient();

    await deliver({ type: 'update', listId: 'list-1', payload: garbledEnvelope() });
    await deliver({ type: 'update', listId: 'list-1', payload: garbledEnvelope() });
    await deliver({ type: 'update', listId: 'list-2', payload: garbledEnvelope() });

    expect(errors).toHaveLength(2);
    expect(errors.map((e) => (e as DecryptFailureError).context)).toEqual(['list-1', 'list-2']);
  });
});

describe('what the user actually sees', () => {
  it('does NOT say "Synced" once a ciphertext has failed', () => {
    // THE TEST THAT MATTERS. A wrong-key device is connected and idle: every
    // signal the socket has says everything is fine. Asserting only that
    // `decryptFailures` incremented is the assertion that passed while the
    // indicator read "Synced".
    useSyncStore.getState().setConnectionState('connected');
    expect(useSyncStore.getState().syncState).toBe('idle');
    expect(rendered().label).toBe('Synced');

    useSyncStore.getState().noteDecryptFailure('list-1');

    expect(rendered().label).not.toBe('Synced');
    expect(rendered().label).toMatch(/can't read/i);
    expect(rendered().color).toBe('#f44336');
  });

  it('survives a reconnect — a key mismatch is not cured by reconnecting', () => {
    useSyncStore.getState().noteDecryptFailure('list-1');
    expect(rendered().label).not.toBe('Synced');

    // The exact sequence that used to erase it: syncState is recomputed from
    // the socket on every transition, and a wrong-key device connects fine.
    useSyncStore.getState().setConnectionState('disconnected');
    useSyncStore.getState().setConnectionState('connecting');
    useSyncStore.getState().setConnectionState('connected');

    expect(useSyncStore.getState().syncState).toBe('idle');
    expect(rendered().label).not.toBe('Synced');
  });

  it('hides the "last synced" timestamp, which reads as reassurance', () => {
    useSyncStore.getState().markSynced();
    expect(useSyncStore.getState().lastSyncedAt).not.toBeNull();

    useSyncStore.getState().noteDecryptFailure('list-1');
    expect(rendered().label).not.toBe('Synced');
  });

  it('routes a DecryptFailureError to the sticky channel, others to syncState', () => {
    // The WIRING, not just the pieces. bootstrap's onSyncError is one line
    // delegating here, so this is the decision that actually runs. A previous
    // version of that callback set `error` alone and the indicator never
    // showed it.
    useSyncStore.getState().reportSyncError(new DecryptFailureError('list-9'));
    expect(useSyncStore.getState().undecryptableLists).toEqual(['list-9']);
    expect(useSyncStore.getState().syncState).not.toBe('error'); // not the generic channel
    expect(rendered().label).toMatch(/can't read/i);

    useSyncStore.setState({ undecryptableLists: [] });
    useSyncStore.getState().reportSyncError(new Error('relay unreachable'));
    expect(useSyncStore.getState().undecryptableLists).toEqual([]);
    expect(useSyncStore.getState().syncState).toBe('error');
    expect(rendered().label).toBe('relay unreachable');
  });

  it('bootstrap delegates to reportSyncError and nothing else', () => {
    // A TRIPWIRE, not a proof — bootstrap needs a relay, a family and a key,
    // none of which exist here. An earlier version of this used
    // /onSyncError:[^}]*reportSyncError/ and was defeated two ways: wrapping
    // the call in `if (Date.now() < 0)`, and adding a dead closure containing
    // the call while restoring `setState({ error })` beside it. `[^}]*` cannot
    // cross the `}` either mutant introduces, so both satisfied the regex
    // while the fix did nothing. So: pin the exact body, and ban the original
    // bug's shape anywhere in the file.
    const src: string = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src/sync/bootstrap.ts'),
      'utf8',
    );

    // The bug this whole change exists to remove — writing the message into a
    // field the indicator never reads. Banned outright, not just in-callback.
    // Comments are stripped first: the fix's own comment quotes the old line.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/setState\(\s*\{\s*error:/);

    const body = src
      .split('onSyncError: (err: Error) => {')[1]
      ?.split('},')[0]
      ?.replace(/\/\/[^\n]*/g, '')
      ?.replace(/\s+/g, ' ')
      .trim();
    // Exact, so an added guard, branch, or extra statement fails.
    expect(body).toBe('useSyncStore.getState().reportSyncError(err);');
  });

  it('renders an ordinary sync error, which used to be invisible', () => {
    // bootstrap wrote `error` without `syncState`, and the label only consults
    // `error` in the error state — so the message went nowhere.
    expect(syncIndicatorStatus({ syncState: 'idle', error: 'boom', undecryptableLists: [] }).label).toBe(
      'Synced',
    );
    expect(
      syncIndicatorStatus({ syncState: 'error', error: 'boom', undecryptableLists: [] }).label,
    ).toBe('boom');
  });

  it('leaves every non-failing state alone', () => {
    const cases: Array<[Parameters<typeof syncIndicatorStatus>[0], string]> = [
      [{ syncState: 'idle', error: null, undecryptableLists: [] }, 'Synced'],
      [{ syncState: 'syncing', error: null, undecryptableLists: [] }, 'Syncing...'],
      [{ syncState: 'offline', error: null, undecryptableLists: [] }, 'Offline'],
      [{ syncState: 'not_configured', error: null, undecryptableLists: [] }, 'Local only'],
    ];
    for (const [state, label] of cases) {
      expect(syncIndicatorStatus(state).label).toBe(label);
    }
  });
});

describe('hydrate withholds the field but does NOT latch the indicator', () => {
  it('returns null on a wrong key, still failing closed', async () => {
    const envelope = await encrypt('secret value', KEY_A, 'item.name');
    const out = await decryptField(JSON.stringify(envelope), KEY_B, 'item.name');
    expect(out).toBeNull();
  });

  it('does not mark the family unreadable — orphaned rows are EXPECTED here', async () => {
    // Joining a family legitimately replaces this device's key and nothing
    // wipes the rows written under the old one; loadItemsFromDB fetches the
    // whole collection with no familyId filter. So a healthy, syncing device
    // hits this on every launch. Driving the indicator from it would latch
    // "can't read your lists" permanently on a device that is fine — a false
    // alarm worse than the silence, because it teaches the user to ignore the
    // one warning that matters.
    const envelope = JSON.stringify(await encrypt('v', KEY_A, 'item.name'));
    for (let i = 0; i < 20; i++) await decryptField(envelope, KEY_B, 'item.name');

    expect(useSyncStore.getState().undecryptableLists).toEqual([]);
    expect(rendered().label).not.toMatch(/can't read/i);
  });

  it('still returns plaintext and legacy rows untouched', async () => {
    expect(await decryptField('a legacy plaintext row', KEY_A, 'item.name')).toBe(
      'a legacy plaintext row',
    );
    expect(await decryptField('{"not":"an envelope"}', KEY_A, 'item.name')).toBe(
      '{"not":"an envelope"}',
    );
  });

  it('round-trips correctly with the right key', async () => {
    const envelope = await encrypt('secret value', KEY_A, 'item.name');
    expect(await decryptField(JSON.stringify(envelope), KEY_A, 'item.name')).toBe('secret value');
  });
});

describe('the warning is retracted when the key starts working', () => {
  it('a list that decrypts again is removed, with no manual clear', async () => {
    // The earlier version counted failures and exposed a clearDecryptFailures()
    // that NOTHING called, so a user who fixed their key kept being told the
    // app could not read their lists — force-quit was the only way out.
    useSyncStore.getState().noteDecryptFailure('list-1');
    expect(rendered().label).toMatch(/can't read/i);

    useSyncStore.getState().noteDecryptOk('list-1');
    expect(useSyncStore.getState().undecryptableLists).toEqual([]);
    expect(rendered().label).toBe('Local only');
  });

  it('going local-only retracts it — leaving a family makes it stale', () => {
    // bootstrapSync sets 'not_configured' when there is no relay/family/key,
    // which is where a user lands after leaving a family. A stale warning
    // there would also cost them Home's tappable "set up sharing" row, since
    // that branch keys off not_configured.
    useSyncStore.getState().noteDecryptFailure('list-1');
    expect(rendered().label).toMatch(/can't read/i);

    useSyncStore.getState().setSyncState('not_configured');
    expect(useSyncStore.getState().undecryptableLists).toEqual([]);
    expect(rendered().label).toBe('Local only');
  });

  it('keeps warning while ANY list is still unreadable', () => {
    useSyncStore.getState().noteDecryptFailure('list-1');
    useSyncStore.getState().noteDecryptFailure('list-2');
    useSyncStore.getState().noteDecryptOk('list-1');
    expect(useSyncStore.getState().undecryptableLists).toEqual(['list-2']);
    expect(rendered().label).toMatch(/can't read/i);
  });

  it('the socket retracts it end to end once decryption succeeds', async () => {
    const { client, errors, deliver } = await makeClient();
    const recovered: string[] = [];
    client.onDecryptRecovered = (listId) => recovered.push(listId);

    await deliver({ type: 'update', listId: 'list-1', payload: garbledEnvelope() });
    expect(errors).toHaveLength(1);

    // Same list, now readable (encrypted under the client's own key).
    const good = await realUpdateEnvelope('list-1');
    await deliver({ type: 'update', listId: 'list-1', payload: good });
    expect(recovered).toEqual(['list-1']);

    // …and it re-reports if it breaks again, rather than staying silent.
    await deliver({ type: 'update', listId: 'list-1', payload: garbledEnvelope() });
    expect(errors).toHaveLength(2);
  });

  it('does not fire recovery for a list that never failed', async () => {
    const { client, deliver } = await makeClient();
    const recovered: string[] = [];
    client.onDecryptRecovered = (listId) => recovered.push(listId);

    await deliver({ type: 'update', listId: 'list-1', payload: await realUpdateEnvelope('list-1') });
    expect(recovered).toEqual([]);
  });
});

describe('a throwing listener cannot break the socket or silence the list', () => {
  it('an onRemoteUpdate throw is NOT relabelled a decryption failure', async () => {
    // The try must cover only the decrypt. onRemoteUpdate routes into
    // Y.applyUpdate and a zustand setState whose subscribers run
    // synchronously, so a bad render came back through the catch and got
    // wrapped in DecryptFailureError by construction — latching "can't read
    // your lists" on a device whose key was correct.
    const { client, errors, deliver } = await makeClient();
    client.onRemoteUpdate = () => {
      throw new Error('a subscriber blew up');
    };

    await deliver({
      type: 'update',
      listId: 'list-1',
      payload: await realUpdateEnvelope('list-1'),
    }).catch(() => undefined);

    expect(errors.filter((e) => e instanceof DecryptFailureError)).toHaveLength(0);
    expect(useSyncStore.getState().undecryptableLists).toEqual([]);
    expect(rendered().label).not.toMatch(/can't read/i);
  });

  it('an onError throw does not escape, and the list is not silenced forever', async () => {
    const { client, deliver } = await makeClient();
    let calls = 0;
    client.onError = () => {
      calls++;
      throw new Error('listener blew up');
    };

    await expect(
      deliver({ type: 'update', listId: 'list-1', payload: garbledEnvelope() }),
    ).resolves.not.toThrow();
    expect(calls).toBe(1);
  });
});

/** The label the indicator would render for the current store state. */
function rendered() {
  const s = useSyncStore.getState();
  return syncIndicatorStatus({
    syncState: s.syncState,
    error: s.error,
    undecryptableLists: s.undecryptableLists,
  });
}
