/**
 * Any enrolled family member can invite, not only the founding device.
 *
 * The membership registry (familyFounderKeys) only ever recorded the first
 * signer for a family, because /enroll never received the joiner's Ed25519
 * signing key. Every invite a joined member created was then refused with
 * "Invite signer is not a registered member of this family".
 *
 * /enroll now takes the joiner's signing key plus a proof of possession and
 * registers it after the enrollment passes every existing check.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nacl = require('tweetnacl');

const PORT = 19949;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let directory;

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function makeInvite(familyId, keypair) {
  const expiresAt = Date.now() + 3600000;
  const nonce = b64(nacl.randomBytes(16));
  const deviceId = b64(keypair.publicKey);
  const payload = JSON.stringify({ familyId, deviceId, expiresAt, nonce });
  const signature = b64(nacl.sign.detached(new TextEncoder().encode(payload), keypair.secretKey));
  return { familyId, deviceId, expiresAt, nonce, signature };
}

async function enroll(invite, { signer, proofSigner, deviceToken = b64(crypto.randomBytes(32)) } = {}) {
  const body = { deviceToken, familyInviteToken: JSON.stringify(invite) };
  if (signer) {
    const message = `pantryrun-enroll-v1:${invite.familyId}:${invite.nonce}:${deviceToken}`;
    body.signingKey = b64(signer.publicKey);
    body.signingProof = b64(nacl.sign.detached(new TextEncoder().encode(message), (proofSigner || signer).secretKey));
  }
  return fetch(`${BASE}/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantryrun-invite-test-'));
  child = spawn(process.execPath, ['-e', "const net=require('net');const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(port,...args){return listen.call(this,port,'127.0.0.1',...args)};require('./server.js')"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), RELAY_PORT: String(PORT), POOL_PORT: String(PORT + 1), RELAY_DATA_DIR: directory, RELAY_STATE_FILE: path.join(directory, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('test relay did not start');
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('a member who joined with its signing key can invite the next device', async () => {
  const familyId = 'fam-members';
  const founder = nacl.sign.keyPair();
  const member = nacl.sign.keyPair();
  expect((await enroll(makeInvite(familyId, founder), { signer: founder })).status).toBe(200);
  expect((await enroll(makeInvite(familyId, founder), { signer: member })).status).toBe(200);

  const res = await enroll(makeInvite(familyId, member));
  expect(res.status).toBe(200);
});

test('a key registered without a valid proof is refused, and its invites stay refused', async () => {
  const familyId = 'fam-proof';
  const founder = nacl.sign.keyPair();
  const claimed = nacl.sign.keyPair();
  expect((await enroll(makeInvite(familyId, founder))).status).toBe(200);

  const bad = await enroll(makeInvite(familyId, founder), { signer: claimed, proofSigner: nacl.sign.keyPair() });
  expect(bad.status).toBe(403);
  expect((await bad.json()).error).toMatch(/signing key proof/i);

  const res = await enroll(makeInvite(familyId, claimed));
  expect(res.status).toBe(403);
  expect((await res.json()).error).toMatch(/not a registered member/i);
});

test('a joiner that sent no signing key still cannot invite (signature checks unchanged)', async () => {
  const familyId = 'fam-legacy';
  const founder = nacl.sign.keyPair();
  const member = nacl.sign.keyPair();
  expect((await enroll(makeInvite(familyId, founder))).status).toBe(200);
  expect((await enroll(makeInvite(familyId, founder))).status).toBe(200);
  expect((await enroll(makeInvite(familyId, member))).status).toBe(403);
});
