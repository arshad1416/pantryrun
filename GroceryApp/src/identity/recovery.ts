/**
 * BIP39-style Recovery Code Module.
 *
 * Generates and verifies a 12-word BIP39 mnemonic phrase that encodes a
 * recovery seed (128-bit entropy). The master key is derived FROM the
 * recovery seed using crypto_generichash, ensuring a perfect round-trip:
 *
 *   generateRecoveryPhrase():
 *     seed (random 16 bytes) → crypto_generichash(32, seed) → masterKey
 *     seed → 12 BIP39 words
 *
 *   recoverFromPhrase(words):
 *     words → seed → crypto_generichash(32, seed) → SAME masterKey ✓
 *
 * This fixes the previous design which hashed the masterKey (one-way) and
 * couldn't reverse the operation, making recovery return a different key.
 *
 * Storage: recovery seed is stored encrypted via expo-secure-store.
 *          master key is stored alongside (same alias as passphrase-derived key).
 */

import {
  initCrypto,
  setMasterKey,
  hasMasterKey,
  getMasterKeyType,
  getMasterKey,
  KeyReadError,
} from '../crypto/index';
// expo-secure-store loaded lazily to avoid Hermes crash (chains to expo-asset at eval time)
let SecureStore: any = null;
async function getSecureStore(): Promise<any> {
  if (!SecureStore) {
    const mod = await import('expo-secure-store');
    SecureStore = mod;
  }
  return SecureStore;
}
import { getFamilyId } from './family';

// ─── Constants ───────────────────────────────────────────────────────────────

const RECOVERY_SEED_ALIAS_PREFIX = 'groceryapp.recovery.seed.';
const RECOVERY_PHRASE_ALIAS_PREFIX = 'groceryapp.recovery.phrase.';
const RECOVERY_STORED_FLAG_PREFIX = 'groceryapp.recovery.stored.';

const ENTROPY_BYTES = 16; // 128 bits
const CHECKSUM_BITS = 4;
const TOTAL_BITS = ENTROPY_BYTES * 8 + CHECKSUM_BITS; // 132
const WORD_COUNT = 12;
const BITS_PER_WORD = 11;

// ─── SHA-256 (pure TS) ───────────────────────────────────────────────────────
//
// react-native-libsodium exposes NO SHA-256 on device: its JSI layer has no
// jsi_crypto_hash_sha256, so `sodium.crypto_hash_sha256` is undefined at
// runtime and the BIP39 checksum below threw "undefined is not a function" —
// which made provisionFirstRun() fail on every real device while the Jest
// suite stayed green (the test mock delegates to libsodium-wrappers, which
// DOES export it). The checksum must stay SHA-256 to remain BIP39-standard,
// so it is computed here in plain TypeScript (FIPS 180-4; inputs are 16-byte
// seeds, so performance is irrelevant). sha256() is exported for the test
// that cross-checks it against libsodium-wrappers' crypto_hash_sha256.

// First 32 bits of the fractional parts of the cube roots of the first 64 primes.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  // Pre-processing: pad to a multiple of 64 bytes — 0x80, zeros, 64-bit
  // big-endian bit length.
  const bitLen = data.length * 8;
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);

  // Initial hash values: fractional parts of the square roots of the first 8 primes.
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outDv.setUint32(i * 4, h[i]);
  return out;
}

// ─── BIP39 English Wordlist ──────────────────────────────────────────────────
//
// The canonical BIP-0039 English list: EXACTLY 2048 words, in the specified
// order. Generated from the spec file, never hand-edited. Its integrity is
// pinned by a sha256 assertion in __tests__/bip39-wordlist.test.ts — NOT by
// this comment, because a comment is precisely what lied here before.
//
// This array previously held 2042 words under a comment claiming 2048. That
// comment was the only thing asserting the count and it was wrong from the
// repository's first commit. Two separate defects followed:
//
//   * The encoder produces 11-bit indices (0..2047), so 2042..2047 indexed
//     past the end. The result is NOT the literal string "undefined" —
//     Array.prototype.join renders an undefined element as EMPTY — so about
//     3.5% of phrases came out as 11 words and a double space. Splitting on
//     /\s+/ then yields 11 words, so no build would ever accept them back.
//     Those users had a dead backup and were never told.
//
//   * Only 401 of 2048 positions matched the real list (first divergence at
//     index 401), so every phrase this app produced was non-standard and
//     unreadable by any conformant BIP39 tool.
//
// Neither defect could ever reach a master key: the key is
// crypto_generichash(32, seed) over raw CSPRNG entropy, and the wordlist is
// only a rendering of that seed. No stored data was at risk — only the
// user's ability to restore it on another device.
//
// Exported ONLY so a test can hash it. Nothing in src/ may import it.
export const BIP39_WORDLIST: readonly string[] = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse',
  'access', 'accident', 'account', 'accuse', 'achieve', 'acid', 'acoustic', 'acquire', 'across', 'act',
  'action', 'actor', 'actress', 'actual', 'adapt', 'add', 'addict', 'address', 'adjust', 'admit',
  'adult', 'advance', 'advice', 'aerobic', 'affair', 'afford', 'afraid', 'again', 'age', 'agent',
  'agree', 'ahead', 'aim', 'air', 'airport', 'aisle', 'alarm', 'album', 'alcohol', 'alert',
  'alien', 'all', 'alley', 'allow', 'almost', 'alone', 'alpha', 'already', 'also', 'alter',
  'always', 'amateur', 'amazing', 'among', 'amount', 'amused', 'analyst', 'anchor', 'ancient', 'anger',
  'angle', 'angry', 'animal', 'ankle', 'announce', 'annual', 'another', 'answer', 'antenna', 'antique',
  'anxiety', 'any', 'apart', 'apology', 'appear', 'apple', 'approve', 'april', 'arch', 'arctic',
  'area', 'arena', 'argue', 'arm', 'armed', 'armor', 'army', 'around', 'arrange', 'arrest',
  'arrive', 'arrow', 'art', 'artefact', 'artist', 'artwork', 'ask', 'aspect', 'assault', 'asset',
  'assist', 'assume', 'asthma', 'athlete', 'atom', 'attack', 'attend', 'attitude', 'attract', 'auction',
  'audit', 'august', 'aunt', 'author', 'auto', 'autumn', 'average', 'avocado', 'avoid', 'awake',
  'aware', 'away', 'awesome', 'awful', 'awkward', 'axis', 'baby', 'bachelor', 'bacon', 'badge',
  'bag', 'balance', 'balcony', 'ball', 'bamboo', 'banana', 'banner', 'bar', 'barely', 'bargain',
  'barrel', 'base', 'basic', 'basket', 'battle', 'beach', 'bean', 'beauty', 'because', 'become',
  'beef', 'before', 'begin', 'behave', 'behind', 'believe', 'below', 'belt', 'bench', 'benefit',
  'best', 'betray', 'better', 'between', 'beyond', 'bicycle', 'bid', 'bike', 'bind', 'biology',
  'bird', 'birth', 'bitter', 'black', 'blade', 'blame', 'blanket', 'blast', 'bleak', 'bless',
  'blind', 'blood', 'blossom', 'blouse', 'blue', 'blur', 'blush', 'board', 'boat', 'body',
  'boil', 'bomb', 'bone', 'bonus', 'book', 'boost', 'border', 'boring', 'borrow', 'boss',
  'bottom', 'bounce', 'box', 'boy', 'bracket', 'brain', 'brand', 'brass', 'brave', 'bread',
  'breeze', 'brick', 'bridge', 'brief', 'bright', 'bring', 'brisk', 'broccoli', 'broken', 'bronze',
  'broom', 'brother', 'brown', 'brush', 'bubble', 'buddy', 'budget', 'buffalo', 'build', 'bulb',
  'bulk', 'bullet', 'bundle', 'bunker', 'burden', 'burger', 'burst', 'bus', 'business', 'busy',
  'butter', 'buyer', 'buzz', 'cabbage', 'cabin', 'cable', 'cactus', 'cage', 'cake', 'call',
  'calm', 'camera', 'camp', 'can', 'canal', 'cancel', 'candy', 'cannon', 'canoe', 'canvas',
  'canyon', 'capable', 'capital', 'captain', 'car', 'carbon', 'card', 'cargo', 'carpet', 'carry',
  'cart', 'case', 'cash', 'casino', 'castle', 'casual', 'cat', 'catalog', 'catch', 'category',
  'cattle', 'caught', 'cause', 'caution', 'cave', 'ceiling', 'celery', 'cement', 'census', 'century',
  'cereal', 'certain', 'chair', 'chalk', 'champion', 'change', 'chaos', 'chapter', 'charge', 'chase',
  'chat', 'cheap', 'check', 'cheese', 'chef', 'cherry', 'chest', 'chicken', 'chief', 'child',
  'chimney', 'choice', 'choose', 'chronic', 'chuckle', 'chunk', 'churn', 'cigar', 'cinnamon', 'circle',
  'citizen', 'city', 'civil', 'claim', 'clap', 'clarify', 'claw', 'clay', 'clean', 'clerk',
  'clever', 'click', 'client', 'cliff', 'climb', 'clinic', 'clip', 'clock', 'clog', 'close',
  'cloth', 'cloud', 'clown', 'club', 'clump', 'cluster', 'clutch', 'coach', 'coast', 'coconut',
  'code', 'coffee', 'coil', 'coin', 'collect', 'color', 'column', 'combine', 'come', 'comfort',
  'comic', 'common', 'company', 'concert', 'conduct', 'confirm', 'congress', 'connect', 'consider', 'control',
  'convince', 'cook', 'cool', 'copper', 'copy', 'coral', 'core', 'corn', 'correct', 'cost',
  'cotton', 'couch', 'country', 'couple', 'course', 'cousin', 'cover', 'coyote', 'crack', 'cradle',
  'craft', 'cram', 'crane', 'crash', 'crater', 'crawl', 'crazy', 'cream', 'credit', 'creek',
  'crew', 'cricket', 'crime', 'crisp', 'critic', 'crop', 'cross', 'crouch', 'crowd', 'crucial',
  'cruel', 'cruise', 'crumble', 'crunch', 'crush', 'cry', 'crystal', 'cube', 'culture', 'cup',
  'cupboard', 'curious', 'current', 'curtain', 'curve', 'cushion', 'custom', 'cute', 'cycle', 'dad',
  'damage', 'damp', 'dance', 'danger', 'daring', 'dash', 'daughter', 'dawn', 'day', 'deal',
  'debate', 'debris', 'decade', 'december', 'decide', 'decline', 'decorate', 'decrease', 'deer', 'defense',
  'define', 'defy', 'degree', 'delay', 'deliver', 'demand', 'demise', 'denial', 'dentist', 'deny',
  'depart', 'depend', 'deposit', 'depth', 'deputy', 'derive', 'describe', 'desert', 'design', 'desk',
  'despair', 'destroy', 'detail', 'detect', 'develop', 'device', 'devote', 'diagram', 'dial', 'diamond',
  'diary', 'dice', 'diesel', 'diet', 'differ', 'digital', 'dignity', 'dilemma', 'dinner', 'dinosaur',
  'direct', 'dirt', 'disagree', 'discover', 'disease', 'dish', 'dismiss', 'disorder', 'display', 'distance',
  'divert', 'divide', 'divorce', 'dizzy', 'doctor', 'document', 'dog', 'doll', 'dolphin', 'domain',
  'donate', 'donkey', 'donor', 'door', 'dose', 'double', 'dove', 'draft', 'dragon', 'drama',
  'drastic', 'draw', 'dream', 'dress', 'drift', 'drill', 'drink', 'drip', 'drive', 'drop',
  'drum', 'dry', 'duck', 'dumb', 'dune', 'during', 'dust', 'dutch', 'duty', 'dwarf',
  'dynamic', 'eager', 'eagle', 'early', 'earn', 'earth', 'easily', 'east', 'easy', 'echo',
  'ecology', 'economy', 'edge', 'edit', 'educate', 'effort', 'egg', 'eight', 'either', 'elbow',
  'elder', 'electric', 'elegant', 'element', 'elephant', 'elevator', 'elite', 'else', 'embark', 'embody',
  'embrace', 'emerge', 'emotion', 'employ', 'empower', 'empty', 'enable', 'enact', 'end', 'endless',
  'endorse', 'enemy', 'energy', 'enforce', 'engage', 'engine', 'enhance', 'enjoy', 'enlist', 'enough',
  'enrich', 'enroll', 'ensure', 'enter', 'entire', 'entry', 'envelope', 'episode', 'equal', 'equip',
  'era', 'erase', 'erode', 'erosion', 'error', 'erupt', 'escape', 'essay', 'essence', 'estate',
  'eternal', 'ethics', 'evidence', 'evil', 'evoke', 'evolve', 'exact', 'example', 'excess', 'exchange',
  'excite', 'exclude', 'excuse', 'execute', 'exercise', 'exhaust', 'exhibit', 'exile', 'exist', 'exit',
  'exotic', 'expand', 'expect', 'expire', 'explain', 'expose', 'express', 'extend', 'extra', 'eye',
  'eyebrow', 'fabric', 'face', 'faculty', 'fade', 'faint', 'faith', 'fall', 'false', 'fame',
  'family', 'famous', 'fan', 'fancy', 'fantasy', 'farm', 'fashion', 'fat', 'fatal', 'father',
  'fatigue', 'fault', 'favorite', 'feature', 'february', 'federal', 'fee', 'feed', 'feel', 'female',
  'fence', 'festival', 'fetch', 'fever', 'few', 'fiber', 'fiction', 'field', 'figure', 'file',
  'film', 'filter', 'final', 'find', 'fine', 'finger', 'finish', 'fire', 'firm', 'first',
  'fiscal', 'fish', 'fit', 'fitness', 'fix', 'flag', 'flame', 'flash', 'flat', 'flavor',
  'flee', 'flight', 'flip', 'float', 'flock', 'floor', 'flower', 'fluid', 'flush', 'fly',
  'foam', 'focus', 'fog', 'foil', 'fold', 'follow', 'food', 'foot', 'force', 'forest',
  'forget', 'fork', 'fortune', 'forum', 'forward', 'fossil', 'foster', 'found', 'fox', 'fragile',
  'frame', 'frequent', 'fresh', 'friend', 'fringe', 'frog', 'front', 'frost', 'frown', 'frozen',
  'fruit', 'fuel', 'fun', 'funny', 'furnace', 'fury', 'future', 'gadget', 'gain', 'galaxy',
  'gallery', 'game', 'gap', 'garage', 'garbage', 'garden', 'garlic', 'garment', 'gas', 'gasp',
  'gate', 'gather', 'gauge', 'gaze', 'general', 'genius', 'genre', 'gentle', 'genuine', 'gesture',
  'ghost', 'giant', 'gift', 'giggle', 'ginger', 'giraffe', 'girl', 'give', 'glad', 'glance',
  'glare', 'glass', 'glide', 'glimpse', 'globe', 'gloom', 'glory', 'glove', 'glow', 'glue',
  'goat', 'goddess', 'gold', 'good', 'goose', 'gorilla', 'gospel', 'gossip', 'govern', 'gown',
  'grab', 'grace', 'grain', 'grant', 'grape', 'grass', 'gravity', 'great', 'green', 'grid',
  'grief', 'grit', 'grocery', 'group', 'grow', 'grunt', 'guard', 'guess', 'guide', 'guilt',
  'guitar', 'gun', 'gym', 'habit', 'hair', 'half', 'hammer', 'hamster', 'hand', 'happy',
  'harbor', 'hard', 'harsh', 'harvest', 'hat', 'have', 'hawk', 'hazard', 'head', 'health',
  'heart', 'heavy', 'hedgehog', 'height', 'hello', 'helmet', 'help', 'hen', 'hero', 'hidden',
  'high', 'hill', 'hint', 'hip', 'hire', 'history', 'hobby', 'hockey', 'hold', 'hole',
  'holiday', 'hollow', 'home', 'honey', 'hood', 'hope', 'horn', 'horror', 'horse', 'hospital',
  'host', 'hotel', 'hour', 'hover', 'hub', 'huge', 'human', 'humble', 'humor', 'hundred',
  'hungry', 'hunt', 'hurdle', 'hurry', 'hurt', 'husband', 'hybrid', 'ice', 'icon', 'idea',
  'identify', 'idle', 'ignore', 'ill', 'illegal', 'illness', 'image', 'imitate', 'immense', 'immune',
  'impact', 'impose', 'improve', 'impulse', 'inch', 'include', 'income', 'increase', 'index', 'indicate',
  'indoor', 'industry', 'infant', 'inflict', 'inform', 'inhale', 'inherit', 'initial', 'inject', 'injury',
  'inmate', 'inner', 'innocent', 'input', 'inquiry', 'insane', 'insect', 'inside', 'inspire', 'install',
  'intact', 'interest', 'into', 'invest', 'invite', 'involve', 'iron', 'island', 'isolate', 'issue',
  'item', 'ivory', 'jacket', 'jaguar', 'jar', 'jazz', 'jealous', 'jeans', 'jelly', 'jewel',
  'job', 'join', 'joke', 'journey', 'joy', 'judge', 'juice', 'jump', 'jungle', 'junior',
  'junk', 'just', 'kangaroo', 'keen', 'keep', 'ketchup', 'key', 'kick', 'kid', 'kidney',
  'kind', 'kingdom', 'kiss', 'kit', 'kitchen', 'kite', 'kitten', 'kiwi', 'knee', 'knife',
  'knock', 'know', 'lab', 'label', 'labor', 'ladder', 'lady', 'lake', 'lamp', 'language',
  'laptop', 'large', 'later', 'latin', 'laugh', 'laundry', 'lava', 'law', 'lawn', 'lawsuit',
  'layer', 'lazy', 'leader', 'leaf', 'learn', 'leave', 'lecture', 'left', 'leg', 'legal',
  'legend', 'leisure', 'lemon', 'lend', 'length', 'lens', 'leopard', 'lesson', 'letter', 'level',
  'liar', 'liberty', 'library', 'license', 'life', 'lift', 'light', 'like', 'limb', 'limit',
  'link', 'lion', 'liquid', 'list', 'little', 'live', 'lizard', 'load', 'loan', 'lobster',
  'local', 'lock', 'logic', 'lonely', 'long', 'loop', 'lottery', 'loud', 'lounge', 'love',
  'loyal', 'lucky', 'luggage', 'lumber', 'lunar', 'lunch', 'luxury', 'lyrics', 'machine', 'mad',
  'magic', 'magnet', 'maid', 'mail', 'main', 'major', 'make', 'mammal', 'man', 'manage',
  'mandate', 'mango', 'mansion', 'manual', 'maple', 'marble', 'march', 'margin', 'marine', 'market',
  'marriage', 'mask', 'mass', 'master', 'match', 'material', 'math', 'matrix', 'matter', 'maximum',
  'maze', 'meadow', 'mean', 'measure', 'meat', 'mechanic', 'medal', 'media', 'melody', 'melt',
  'member', 'memory', 'mention', 'menu', 'mercy', 'merge', 'merit', 'merry', 'mesh', 'message',
  'metal', 'method', 'middle', 'midnight', 'milk', 'million', 'mimic', 'mind', 'minimum', 'minor',
  'minute', 'miracle', 'mirror', 'misery', 'miss', 'mistake', 'mix', 'mixed', 'mixture', 'mobile',
  'model', 'modify', 'mom', 'moment', 'monitor', 'monkey', 'monster', 'month', 'moon', 'moral',
  'more', 'morning', 'mosquito', 'mother', 'motion', 'motor', 'mountain', 'mouse', 'move', 'movie',
  'much', 'muffin', 'mule', 'multiply', 'muscle', 'museum', 'mushroom', 'music', 'must', 'mutual',
  'myself', 'mystery', 'myth', 'naive', 'name', 'napkin', 'narrow', 'nasty', 'nation', 'nature',
  'near', 'neck', 'need', 'negative', 'neglect', 'neither', 'nephew', 'nerve', 'nest', 'net',
  'network', 'neutral', 'never', 'news', 'next', 'nice', 'night', 'noble', 'noise', 'nominee',
  'noodle', 'normal', 'north', 'nose', 'notable', 'note', 'nothing', 'notice', 'novel', 'now',
  'nuclear', 'number', 'nurse', 'nut', 'oak', 'obey', 'object', 'oblige', 'obscure', 'observe',
  'obtain', 'obvious', 'occur', 'ocean', 'october', 'odor', 'off', 'offer', 'office', 'often',
  'oil', 'okay', 'old', 'olive', 'olympic', 'omit', 'once', 'one', 'onion', 'online',
  'only', 'open', 'opera', 'opinion', 'oppose', 'option', 'orange', 'orbit', 'orchard', 'order',
  'ordinary', 'organ', 'orient', 'original', 'orphan', 'ostrich', 'other', 'outdoor', 'outer', 'output',
  'outside', 'oval', 'oven', 'over', 'own', 'owner', 'oxygen', 'oyster', 'ozone', 'pact',
  'paddle', 'page', 'pair', 'palace', 'palm', 'panda', 'panel', 'panic', 'panther', 'paper',
  'parade', 'parent', 'park', 'parrot', 'party', 'pass', 'patch', 'path', 'patient', 'patrol',
  'pattern', 'pause', 'pave', 'payment', 'peace', 'peanut', 'pear', 'peasant', 'pelican', 'pen',
  'penalty', 'pencil', 'people', 'pepper', 'perfect', 'permit', 'person', 'pet', 'phone', 'photo',
  'phrase', 'physical', 'piano', 'picnic', 'picture', 'piece', 'pig', 'pigeon', 'pill', 'pilot',
  'pink', 'pioneer', 'pipe', 'pistol', 'pitch', 'pizza', 'place', 'planet', 'plastic', 'plate',
  'play', 'please', 'pledge', 'pluck', 'plug', 'plunge', 'poem', 'poet', 'point', 'polar',
  'pole', 'police', 'pond', 'pony', 'pool', 'popular', 'portion', 'position', 'possible', 'post',
  'potato', 'pottery', 'poverty', 'powder', 'power', 'practice', 'praise', 'predict', 'prefer', 'prepare',
  'present', 'pretty', 'prevent', 'price', 'pride', 'primary', 'print', 'priority', 'prison', 'private',
  'prize', 'problem', 'process', 'produce', 'profit', 'program', 'project', 'promote', 'proof', 'property',
  'prosper', 'protect', 'proud', 'provide', 'public', 'pudding', 'pull', 'pulp', 'pulse', 'pumpkin',
  'punch', 'pupil', 'puppy', 'purchase', 'purity', 'purpose', 'purse', 'push', 'put', 'puzzle',
  'pyramid', 'quality', 'quantum', 'quarter', 'question', 'quick', 'quit', 'quiz', 'quote', 'rabbit',
  'raccoon', 'race', 'rack', 'radar', 'radio', 'rail', 'rain', 'raise', 'rally', 'ramp',
  'ranch', 'random', 'range', 'rapid', 'rare', 'rate', 'rather', 'raven', 'raw', 'razor',
  'ready', 'real', 'reason', 'rebel', 'rebuild', 'recall', 'receive', 'recipe', 'record', 'recycle',
  'reduce', 'reflect', 'reform', 'refuse', 'region', 'regret', 'regular', 'reject', 'relax', 'release',
  'relief', 'rely', 'remain', 'remember', 'remind', 'remove', 'render', 'renew', 'rent', 'reopen',
  'repair', 'repeat', 'replace', 'report', 'require', 'rescue', 'resemble', 'resist', 'resource', 'response',
  'result', 'retire', 'retreat', 'return', 'reunion', 'reveal', 'review', 'reward', 'rhythm', 'rib',
  'ribbon', 'rice', 'rich', 'ride', 'ridge', 'rifle', 'right', 'rigid', 'ring', 'riot',
  'ripple', 'risk', 'ritual', 'rival', 'river', 'road', 'roast', 'robot', 'robust', 'rocket',
  'romance', 'roof', 'rookie', 'room', 'rose', 'rotate', 'rough', 'round', 'route', 'royal',
  'rubber', 'rude', 'rug', 'rule', 'run', 'runway', 'rural', 'sad', 'saddle', 'sadness',
  'safe', 'sail', 'salad', 'salmon', 'salon', 'salt', 'salute', 'same', 'sample', 'sand',
  'satisfy', 'satoshi', 'sauce', 'sausage', 'save', 'say', 'scale', 'scan', 'scare', 'scatter',
  'scene', 'scheme', 'school', 'science', 'scissors', 'scorpion', 'scout', 'scrap', 'screen', 'script',
  'scrub', 'sea', 'search', 'season', 'seat', 'second', 'secret', 'section', 'security', 'seed',
  'seek', 'segment', 'select', 'sell', 'seminar', 'senior', 'sense', 'sentence', 'series', 'service',
  'session', 'settle', 'setup', 'seven', 'shadow', 'shaft', 'shallow', 'share', 'shed', 'shell',
  'sheriff', 'shield', 'shift', 'shine', 'ship', 'shiver', 'shock', 'shoe', 'shoot', 'shop',
  'short', 'shoulder', 'shove', 'shrimp', 'shrug', 'shuffle', 'shy', 'sibling', 'sick', 'side',
  'siege', 'sight', 'sign', 'silent', 'silk', 'silly', 'silver', 'similar', 'simple', 'since',
  'sing', 'siren', 'sister', 'situate', 'six', 'size', 'skate', 'sketch', 'ski', 'skill',
  'skin', 'skirt', 'skull', 'slab', 'slam', 'sleep', 'slender', 'slice', 'slide', 'slight',
  'slim', 'slogan', 'slot', 'slow', 'slush', 'small', 'smart', 'smile', 'smoke', 'smooth',
  'snack', 'snake', 'snap', 'sniff', 'snow', 'soap', 'soccer', 'social', 'sock', 'soda',
  'soft', 'solar', 'soldier', 'solid', 'solution', 'solve', 'someone', 'song', 'soon', 'sorry',
  'sort', 'soul', 'sound', 'soup', 'source', 'south', 'space', 'spare', 'spatial', 'spawn',
  'speak', 'special', 'speed', 'spell', 'spend', 'sphere', 'spice', 'spider', 'spike', 'spin',
  'spirit', 'split', 'spoil', 'sponsor', 'spoon', 'sport', 'spot', 'spray', 'spread', 'spring',
  'spy', 'square', 'squeeze', 'squirrel', 'stable', 'stadium', 'staff', 'stage', 'stairs', 'stamp',
  'stand', 'start', 'state', 'stay', 'steak', 'steel', 'stem', 'step', 'stereo', 'stick',
  'still', 'sting', 'stock', 'stomach', 'stone', 'stool', 'story', 'stove', 'strategy', 'street',
  'strike', 'strong', 'struggle', 'student', 'stuff', 'stumble', 'style', 'subject', 'submit', 'subway',
  'success', 'such', 'sudden', 'suffer', 'sugar', 'suggest', 'suit', 'summer', 'sun', 'sunny',
  'sunset', 'super', 'supply', 'supreme', 'sure', 'surface', 'surge', 'surprise', 'surround', 'survey',
  'suspect', 'sustain', 'swallow', 'swamp', 'swap', 'swarm', 'swear', 'sweet', 'swift', 'swim',
  'swing', 'switch', 'sword', 'symbol', 'symptom', 'syrup', 'system', 'table', 'tackle', 'tag',
  'tail', 'talent', 'talk', 'tank', 'tape', 'target', 'task', 'taste', 'tattoo', 'taxi',
  'teach', 'team', 'tell', 'ten', 'tenant', 'tennis', 'tent', 'term', 'test', 'text',
  'thank', 'that', 'theme', 'then', 'theory', 'there', 'they', 'thing', 'this', 'thought',
  'three', 'thrive', 'throw', 'thumb', 'thunder', 'ticket', 'tide', 'tiger', 'tilt', 'timber',
  'time', 'tiny', 'tip', 'tired', 'tissue', 'title', 'toast', 'tobacco', 'today', 'toddler',
  'toe', 'together', 'toilet', 'token', 'tomato', 'tomorrow', 'tone', 'tongue', 'tonight', 'tool',
  'tooth', 'top', 'topic', 'topple', 'torch', 'tornado', 'tortoise', 'toss', 'total', 'tourist',
  'toward', 'tower', 'town', 'toy', 'track', 'trade', 'traffic', 'tragic', 'train', 'transfer',
  'trap', 'trash', 'travel', 'tray', 'treat', 'tree', 'trend', 'trial', 'tribe', 'trick',
  'trigger', 'trim', 'trip', 'trophy', 'trouble', 'truck', 'true', 'truly', 'trumpet', 'trust',
  'truth', 'try', 'tube', 'tuition', 'tumble', 'tuna', 'tunnel', 'turkey', 'turn', 'turtle',
  'twelve', 'twenty', 'twice', 'twin', 'twist', 'two', 'type', 'typical', 'ugly', 'umbrella',
  'unable', 'unaware', 'uncle', 'uncover', 'under', 'undo', 'unfair', 'unfold', 'unhappy', 'uniform',
  'unique', 'unit', 'universe', 'unknown', 'unlock', 'until', 'unusual', 'unveil', 'update', 'upgrade',
  'uphold', 'upon', 'upper', 'upset', 'urban', 'urge', 'usage', 'use', 'used', 'useful',
  'useless', 'usual', 'utility', 'vacant', 'vacuum', 'vague', 'valid', 'valley', 'valve', 'van',
  'vanish', 'vapor', 'various', 'vast', 'vault', 'vehicle', 'velvet', 'vendor', 'venture', 'venue',
  'verb', 'verify', 'version', 'very', 'vessel', 'veteran', 'viable', 'vibrant', 'vicious', 'victory',
  'video', 'view', 'village', 'vintage', 'violin', 'virtual', 'virus', 'visa', 'visit', 'visual',
  'vital', 'vivid', 'vocal', 'voice', 'void', 'volcano', 'volume', 'vote', 'voyage', 'wage',
  'wagon', 'wait', 'walk', 'wall', 'walnut', 'want', 'warfare', 'warm', 'warrior', 'wash',
  'wasp', 'waste', 'water', 'wave', 'way', 'wealth', 'weapon', 'wear', 'weasel', 'weather',
  'web', 'wedding', 'weekend', 'weird', 'welcome', 'west', 'wet', 'whale', 'what', 'wheat',
  'wheel', 'when', 'where', 'whip', 'whisper', 'wide', 'width', 'wife', 'wild', 'will',
  'win', 'window', 'wine', 'wing', 'wink', 'winner', 'winter', 'wire', 'wisdom', 'wise',
  'wish', 'witness', 'wolf', 'woman', 'wonder', 'wood', 'wool', 'word', 'work', 'world',
  'worry', 'worth', 'wrap', 'wreck', 'wrestle', 'wrist', 'write', 'wrong', 'yard', 'year',
  'yellow', 'you', 'young', 'youth', 'zebra', 'zero', 'zone', 'zoo',
] as const;

/**
 * Thrown when restoring would replace a key that itself came from a recovery
 * phrase, orphaning everything encrypted under it.
 *
 * Distinct from a plain Error so the caller can tell "this phrase is wrong"
 * (retry) apart from "this phrase may be right but the cost of being wrong is
 * unrecoverable" (confirm). Callers that have genuinely confirmed with the
 * user re-invoke with `{ allowOverwrite: true }`.
 */
/**
 * The nine words that appeared in this app's old 2042-word list but are NOT in
 * canonical BIP39. Seeing one proves a phrase was written under the old build.
 *
 * This is a DIAGNOSTIC, never a decoder — a deliberate product decision, and
 * the honest accounting is this (all figures measured over 200k+ seeds
 * against both real lists):
 *
 *   What ships (canonical only): an old-list phrase is silently accepted
 *     5.76% of the time and recovers the correct entropy in ZERO cases. The
 *     rest fail loudly.
 *   A canonical-first, legacy-fallback decoder: WOULD correctly recover
 *     90.7% of old-list phrases. Its cost is that garbled input gets easier
 *     to accept — a one-word substitution false-accepts 6.1% -> 11.4%
 *     (1.85x) — and that cost is permanent, paid by every future user, while
 *     the benefit expires with the pre-fix cohort.
 *
 * An earlier version of this comment cited the 5.76%/zero-correct figure as
 * the cost of the fallback. That was wrong: it is the cost of what shipped.
 * The decision still stands, but on its real grounds — the affected cohort is
 * bounded by a closed-beta window, the phrase is derived on read so anyone
 * with a working device self-heals, and a permanent halving of typo
 * resistance is a poor trade for a population that expires. If that cohort
 * turns out to be non-trivial, adding the fallback is ~6 lines plus the old
 * array, and this comment is the record of what it would buy.
 *
 * Nine strings and not the whole 2042-word array, because a diagnostic only
 * needs to recognise, not decode. A wrong key here is unrecoverable and looks like success, so
 * the only safe move is to refuse and say something useful.
 *
 * It fires for the ~5% of old phrases that contain one of these words. Of the
 * rest, ~86% fail the checksum and read as a typo, and 5.76% are accepted
 * with a wrong key — so this is a partial mitigation, not a safety net.
 */
const LEGACY_ONLY_WORDS: ReadonlySet<string> = new Set([
  'embryo', 'emperor', 'exceed', 'foreign', 'player',
  'rip', 'ripe', 'support', 'suppose',
]);

export class RecoveryOverwriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryOverwriteError';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a lookup Set from the BIP39 wordlist for O(1) validation.
 */
function createWordlistSet(): Set<string> {
  return new Set(BIP39_WORDLIST);
}

/**
 * Convert 128 bits (16 bytes) + 4-bit checksum into 12 word indices.
 * Each word index is 11 bits.
 *
 * @internal Exported for testing only.
 */
export function entropyToWordIndices(entropy: Uint8Array): number[] {
  if (entropy.length !== ENTROPY_BYTES) {
    throw new Error(`Entropy must be ${ENTROPY_BYTES} bytes`);
  }

  // Calculate checksum: first CHECKSUM_BITS bits of SHA-256 of entropy.
  // Pure-TS sha256 — react-native-libsodium has no crypto_hash_sha256 on
  // device (see the sha256 doc comment above).
  const hash = sha256(entropy);
  const checksum = hash[0] >> (8 - CHECKSUM_BITS); // top CHECKSUM_BITS bits

  // Build a 132-bit big-endian buffer: 128 bits entropy + 4 bits checksum
  // The checksum sits immediately after the entropy (bits 128-131).
  //
  // Approach: treat the buffer as a single big-endian number and extract
  // 11-bit chunks using BigInt to avoid all manual bit-twiddling errors.

  // Build entropy as BigInt (16 bytes → 128 bits)
  let buffer = 0n;
  for (let i = 0; i < ENTROPY_BYTES; i++) {
    buffer = (buffer << 8n) | BigInt(entropy[i]);
  }
  // Append checksum (4 bits)
  buffer = (buffer << 4n) | BigInt(checksum);

  // Extract 12 words × 11 bits each, from MSB to LSB
  const indices: number[] = [];
  for (let w = 0; w < WORD_COUNT; w++) {
    const shiftBits = BigInt(TOTAL_BITS - (w + 1) * BITS_PER_WORD);
    const word = Number((buffer >> shiftBits) & 0x7FFn);
    indices.push(word);
  }

  return indices;
}

/**
 * Convert 12 word indices back to 128-bit entropy.
 * Validates checksum during the conversion.
 *
 * @internal Exported for testing only.
 */
export function wordIndicesToEntropy(indices: number[]): Uint8Array {
  if (indices.length !== WORD_COUNT) {
    throw new Error(`Expected ${WORD_COUNT} word indices, got ${indices.length}`);
  }

  // Reconstruct the 132-bit value from 11-bit chunks using BigInt
  let buffer = 0n;
  for (let w = 0; w < WORD_COUNT; w++) {
    const index = indices[w];
    // Derived from the array, never a literal. A literal 2048 here against a
    // 2042-entry array is exactly what let the encoder address past the end
    // for the whole life of this file.
    if (index < 0 || index >= BIP39_WORDLIST.length) {
      throw new Error(`Word index out of range: ${index}`);
    }
    buffer = (buffer << 11n) | BigInt(index);
  }

  // Extract entropy: top 128 bits (16 bytes)
  const entropy = new Uint8Array(ENTROPY_BYTES);
  const entropyBuffer = buffer >> 4n; // Remove checksum (bottom 4 bits)
  for (let i = 0; i < ENTROPY_BYTES; i++) {
    const shiftBits = BigInt((ENTROPY_BYTES - 1 - i) * 8);
    entropy[i] = Number((entropyBuffer >> shiftBits) & 0xFFn);
  }

  // Extract stored checksum (bottom 4 bits of the 132-bit value)
  const storedChecksum = Number(buffer & 0xFn);

  // Verify checksum (pure-TS sha256 — no crypto_hash_sha256 on device)
  const hash = sha256(entropy);
  const expectedChecksum = hash[0] >> (8 - CHECKSUM_BITS);

  if (storedChecksum !== expectedChecksum) {
    throw new Error('Recovery phrase checksum mismatch — phrase is invalid or corrupted');
  }

  return entropy;
}

// ─── Recovery Seed Management ────────────────────────────────────────────────

/**
 * Get the stored recovery seed for a family.
 * Returns null if no seed has been generated yet.
 */
async function getRecoverySeed(familyId: string): Promise<Uint8Array | null> {
  try {
    const stored = await (await getSecureStore()).getItemAsync(
      `${RECOVERY_SEED_ALIAS_PREFIX}${familyId}`,
    );
    if (!stored) return null;

    // Validate before trusting. `new Uint8Array([NaN])` is 0, so the previous
    // one-liner turned any malformed byte into a silent zero and returned a
    // wrong seed that looked perfectly well-formed. This function had never
    // executed anywhere in the codebase, so that was untested on the one input
    // that must not fail open — it is now the source of truth for the phrase.
    const parts = stored.split(',');
    if (parts.length !== ENTROPY_BYTES) return null;
    const bytes = new Uint8Array(ENTROPY_BYTES);
    for (let i = 0; i < ENTROPY_BYTES; i++) {
      if (!/^\d{1,3}$/.test(parts[i])) return null;
      const v = Number(parts[i]);
      if (!Number.isInteger(v) || v < 0 || v > 255) return null;
      bytes[i] = v;
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Store a recovery seed for a family.
 */
async function setRecoverySeed(familyId: string, seed: Uint8Array): Promise<void> {
  await (await getSecureStore()).setItemAsync(
    `${RECOVERY_SEED_ALIAS_PREFIX}${familyId}`,
    Array.from(seed).join(','),
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a 12-word BIP39 recovery phrase from a fresh random seed.
 *
 * The recovery seed (16 random bytes) is the ROOT entropy. The master key
 * is derived FROM the seed via crypto_generichash(32, seed), ensuring that
 * recovery produces the exact same master key as the original setup.
 *
 * This is a fundamental fix for the previous design which hashed the master
 * key (one-way operation) and couldn't reverse it, making recovery return
 * a completely different key (DATA LOSS bug).
 *
 * When this function is called, it:
 *   1. Generates 16 random bytes (recovery seed)
 *   2. Hashes the seed to derive the master key (crypto_generichash)
 *   3. Stores both the seed and the master key in SecureStore
 *   4. Encodes the seed as 12 BIP39 words
 *   5. Returns the phrase
 *
 * NOTE: This REPLACES the existing master key (if any) with a recovery-derived
 * key. The previous passphrase-derived key is no longer used. This means
 * data encrypted with the old key must be re-encrypted or re-created.
 * Since the previous recovery system was completely broken (C1 — data loss),
 * this is not a functional regression.
 *
 * @returns The 12-word recovery phrase as a space-separated string.
 * @throws If no family membership is found.
 */
export async function generateRecoveryPhrase(): Promise<string> {
  await initCrypto();
  const sodium = require('react-native-libsodium');
  await sodium.ready;

  const familyId = await getFamilyId();
  if (!familyId) {
    throw new Error('No family membership found.');
  }

  // Guard: prevent overwriting an existing master key
  // The two-key-root issue (recovery key vs passphrase-derived key) is not
  // yet reconciled. Overwriting would orphan all encrypted data.
  if (await hasMasterKey()) {
    throw new Error(
      'Cannot generate recovery phrase after data has been encrypted. ' +
      'Recovery phrase must be created during family setup.',
    );
  }

  // Generate 16 bytes of fresh random entropy as the recovery seed
  const entropy = sodium.randombytes_buf(ENTROPY_BYTES);

  // Derive the master key FROM the recovery seed using crypto_generichash
  // This is a one-way derivation, BUT the forward and reverse paths both
  // use the same operation: seed → hash → masterKey. Recovery decodes the
  // phrase back to the seed, then re-applies the same hash → same key.
  const masterKey = sodium.crypto_generichash(32, entropy);

  // Store the master key (overwrites any passphrase-derived key)
  await setMasterKey(masterKey);

  // Store the recovery seed for later display/verification
  await setRecoverySeed(familyId, entropy);

  // Encode entropy to word indices
  const indices = entropyToWordIndices(entropy);

  // Map to words
  const words = indices.map((i) => BIP39_WORDLIST[i]);
  const phrase = words.join(' ');

  // The phrase is NOT persisted. It is a pure rendering of the seed stored
  // above, so storing it would be a second at-rest copy of the same secret
  // that can go stale — which is exactly what happened: every phrase written
  // under the 2042-word list stayed on disk and kept being displayed long
  // after it stopped being decodable. getStoredRecoveryPhrase re-derives.
  return phrase;
}

/**
 * Recover the master key from a 12-word BIP39 recovery phrase.
 *
 * The recovery phrase encodes the recovery seed (16 bytes of entropy).
 * This function:
 *   1. Decodes the words back to the 16-byte seed
 *   2. Hashes the seed via crypto_generichash(32, seed) to derive the
 *      exact same 32-byte master key that was generated during setup
 *   3. Stores the master key in SecureStore
 *
 * Round-trip guarantee:
 *   generateRecoveryPhrase() → phrase
 *   recoverFromPhrase(phrase) → SAME master key ✓
 *
 * @param phrase - Space-separated 12-word BIP39 recovery phrase.
 * @returns The recovered master key as a Uint8Array.
 * @throws If the phrase is invalid (wrong word count, unknown words, bad checksum).
 */
export async function recoverFromPhrase(
  phrase: string,
  { allowOverwrite = false }: { allowOverwrite?: boolean } = {},
): Promise<Uint8Array> {
  await initCrypto();
  const sodium = require('react-native-libsodium');
  await sodium.ready;

  // Validate the phrase first
  // Diagnose an old-wordlist phrase BEFORE the generic validity check, which
  // would otherwise collapse it into "check your spelling" — advice that
  // cannot possibly work and sends the user hunting for a typo that is not
  // there. This has to come first because verifyRecoveryPhrase rejects these
  // phrases for a reason it cannot explain.
  for (const word of phrase.trim().toLowerCase().split(/\s+/)) {
    if (LEGACY_ONLY_WORDS.has(word)) {
      throw new Error(
        `The word "${word}" is from an older version of PantryRun, which used ` +
          'a non-standard word list. This phrase cannot be used to restore. ' +
          'Open PantryRun on a device that still has your lists, go to ' +
          'Settings → Recovery Phrase, and write down the new words shown there.',
      );
    }
  }

  const validation = verifyRecoveryPhrase(phrase);
  if (!validation) {
    throw new Error('Invalid recovery phrase. Check word count, spelling, and word list.');
  }

  // Parse words to indices
  const words = phrase.trim().toLowerCase().split(/\s+/);
  const wordlistSet = createWordlistSet();
  const indices: number[] = [];

  for (const word of words) {
    if (!wordlistSet.has(word)) {
      throw new Error(`Word "${word}" is not in the BIP39 wordlist`);
    }
    const idx = BIP39_WORDLIST.indexOf(word);
    if (idx === -1) {
      throw new Error(`Word "${word}" not found in wordlist`);
    }
    indices.push(idx);
  }

  // Recover entropy from indices (validates checksum)
  const entropy = wordIndicesToEntropy(indices);

  // Derive the master key from the recovery seed using crypto_generichash
  // This produces the EXACT same 32-byte key as generateRecoveryPhrase()
  const masterKey = sodium.crypto_generichash(32, entropy);

  // REFUSE to silently replace a key that was itself established by recovery.
  //
  // setMasterKey is a bare overwrite of one non-family-scoped alias
  // (crypto/index.ts:460), and every item already encrypted under the old key
  // becomes unreadable the moment it lands. generateRecoveryPhrase guards the
  // identical overwrite ("Overwriting would orphan all encrypted data") and
  // this path did not.
  //
  // A 12-word phrase is protected by only 4 checksum bits, so ~1 in 16 wrong
  // phrases decode "successfully" to wrong entropy. That has always been true;
  // what changed is the population. Measured over 300k seeds, a phrase written
  // down under the old 2042-word list is silently accepted here 5.7% of the
  // time, and recovers the correct entropy in ZERO cases. Without this guard,
  // one in eighteen such users would destroy a working key and be shown
  // "Recovery Successful".
  //
  // The discriminator is the key TYPE, not merely whether a key exists:
  // 'device' means this device provisioned a family-of-one and is now joining
  // a real family, which legitimately must overwrite. Using hasMasterKey()
  // here instead would break that documented join flow.
  //
  // Fire only when the write would actually CHANGE the key. Re-entering the
  // same phrase — which the Settings → Recover path invites, and which the
  // join flow does legitimately — derives the identical key and destroys
  // nothing, so blocking it would be a false alarm on the common case.
  // A stored key that cannot be read is the recovery path out of the
  // "couldn't read the encryption key" startup screen. Whether it matches is
  // unknowable, so it counts as a change and needs the explicit confirmation.
  let existingKey: Uint8Array | null;
  let existingUnreadable = false;
  try {
    existingKey = await getMasterKey();
  } catch (err) {
    if (!(err instanceof KeyReadError)) throw err;
    existingKey = null;
    existingUnreadable = true;
  }
  const wouldChangeKey =
    existingUnreadable ||
    (existingKey !== null &&
      (existingKey.length !== masterKey.length ||
        existingKey.some((b, i) => b !== masterKey[i])));

  // Any key change, not only one over a 'recovery'-tagged key. An earlier
  // version also required existingType === 'recovery', which made the guard
  // unreachable on the path that actually matters: a first-run device is
  // tagged 'device' by sync/bootstrap.ts, and PairingScreen routes every new
  // joiner straight into recovery, so the population the guard exists to
  // protect never met the condition. Whether the key being destroyed came
  // from a phrase or from first-run provisioning does not change that
  // destroying it orphans everything encrypted under it.
  //
  // Not gated on merely HAVING a key — `wouldChangeKey` above already
  // excludes re-entering the same phrase, which is the common, harmless case
  // and must not raise a dialog.
  if (wouldChangeKey && !allowOverwrite) {
    if (existingUnreadable) {
      throw new RecoveryOverwriteError(
        "This device's stored key could not be read, so it can't be checked against this " +
          'phrase. If this is your family\'s phrase, replacing the key restores access to lists ' +
          'encrypted under it. If it is not, lists saved under the old key stay unreadable.',
      );
    }
    const existingType = await getMasterKeyType().catch(() => null);
    throw new RecoveryOverwriteError(
      existingType === 'recovery'
        ? 'This device already holds a key restored from a recovery phrase. ' +
            'Restoring a different one would permanently orphan everything ' +
            'encrypted under it. Continue only if you are sure this phrase is ' +
            'the right one.'
        : 'This device already has its own lists, encrypted under a key this ' +
            'phrase would replace. Those lists would be permanently ' +
            'unreadable. This is expected when joining a family you were ' +
            'invited to; cancel if you did not mean to.',
    );
  }

  // Store the recovered master key in SecureStore (overwrites old key if any)
  await setMasterKey(masterKey);

  // Persist the seed under the current familyId. Without this, every device
  // that JOINED a family (rather than founding one) had hasRecoveryPhrase()
  // === false and getStoredRecoveryPhrase() === null, so Settings → View
  // Recovery Phrase fell through to generateRecoveryPhrase(), which throws
  // once a master key exists. Skipped when no family membership exists yet
  // (recovery outside the join flow) — there is no familyId to key by.
  //
  // Only the seed: the phrase is derived from it on read, and the separate
  // stored-flag is gone because hasRecoveryPhrase now keys off the seed too.
  const familyId = await getFamilyId();
  if (familyId) {
    await setRecoverySeed(familyId, entropy);
  }

  return masterKey;
}

/**
 * Quick validation of a recovery phrase.
 * Checks word count, all words in BIP39 wordlist, and checksum validity.
 *
 * @param phrase - The recovery phrase to validate.
 * @returns true if the phrase is valid, false otherwise.
 */
export function verifyRecoveryPhrase(phrase: string): boolean {
  try {
    if (!phrase || typeof phrase !== 'string') return false;

    const words = phrase.trim().toLowerCase().split(/\s+/);

    // Must be exactly 12 words
    if (words.length !== WORD_COUNT) return false;

    // All words must be in the BIP39 wordlist
    const wordlistSet = createWordlistSet();
    for (const word of words) {
      if (!wordlistSet.has(word)) return false;
    }

    // Convert to indices
    const indices = words.map((w) => BIP39_WORDLIST.indexOf(w));
    if (indices.some((i) => i === -1)) return false;

    // Verify checksum (will throw if invalid)
    wordIndicesToEntropy(indices);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a recovery phrase has been generated and stored for this family.
 *
 * @returns true if a recovery phrase exists.
 */
export async function hasRecoveryPhrase(): Promise<boolean> {
  try {
    const familyId = await getFamilyId();
    if (!familyId) return false;

    // Keyed off the SEED, so this cannot disagree with
    // getStoredRecoveryPhrase. The old separate 'stored' flag could: a device
    // holding a seed but no flag reported false here, which suppressed the
    // Home backup banner (HomeScreen.tsx:178) for a user who did have a
    // recoverable family and simply was never prompted to write it down.
    return (await getRecoverySeed(familyId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Get this family's recovery phrase, for display.
 *
 * DERIVED from the stored seed on every call, never read back from storage.
 * The seed is the root secret; the phrase is only a rendering of it, and
 * `entropyToWordIndices` is a pure function, so re-deriving is idempotent by
 * construction — there is no migration to run, no version stamp to keep, and
 * nothing that can be left half-done if the app is killed mid-upgrade.
 *
 * This is what repairs the two cohorts the old wordlist stranded, with no
 * user action and no code that knows either cohort exists:
 *   * phrases encoded against the 2042-word list, which no build would accept
 *   * phrases holed by an out-of-range index, which came out as 11 words
 * Both had an intact seed the whole time. Reading the seed instead of the
 * stale string hands them a correct phrase the next time they open the screen.
 *
 * It also removes a second at-rest copy of the recovery secret: the phrase is
 * no longer written to SecureStore at all.
 *
 * @returns The phrase, or null when this family has no seed.
 */
export async function getStoredRecoveryPhrase(): Promise<string | null> {
  try {
    const familyId = await getFamilyId();
    if (!familyId) return null;

    const seed = await getRecoverySeed(familyId);
    if (!seed) return null;

    return entropyToWordIndices(seed)
      .map((i) => BIP39_WORDLIST[i])
      .join(' ');
  } catch {
    return null;
  }
}

/**
 * Clear the stored recovery phrase (e.g., on family leave/reset).
 */
export async function clearRecoveryPhrase(): Promise<void> {
  try {
    const familyId = await getFamilyId();
    if (familyId) {
      await (await getSecureStore()).deleteItemAsync(
        `${RECOVERY_PHRASE_ALIAS_PREFIX}${familyId}`,
      );
      await (await getSecureStore()).deleteItemAsync(
        `${RECOVERY_STORED_FLAG_PREFIX}${familyId}`,
      );
      await (await getSecureStore()).deleteItemAsync(
        `${RECOVERY_SEED_ALIAS_PREFIX}${familyId}`,
      );
    }
  } catch {
    // Ignore errors during cleanup
  }
}