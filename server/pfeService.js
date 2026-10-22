'use strict';

/**
 * pfeService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Polynomial Functional Encryption engine using Microsoft SEAL (BFV scheme)
 * via node-seal.
 *
 * BFV parameters (unchanged from earlier revisions — see evaluation_notes.md):
 *   polyModulusDegree : 4096
 *   plainModulus      : PlainModulus.Batching(4096, 20)  (a 20-bit NTT-friendly prime)
 *
 * Compatibility score (kidney-optimised):
 *   score = HLA_WEIGHT·(donor.hla - recip.hla)^2
 *         + W·[ isA_d·(1-isA_r) + isB_d·(1-isB_r) + isRh_d·(1-isRh_r) ]
 *
 * The bracketed term is a real ABO/Rh donor→recipient compatibility check
 * (0 = fully compatible, up to 3 = incompatible on every antigen), evaluated
 * homomorphically from each side's (isA, isB, isRhPos) blood-type
 * decomposition — NOT a crude "same blood type or not" difference. This
 * replaced an earlier version that collapsed blood type to a single
 * `bloodType > 0` bit (so e.g. B+ and O- were indistinguishable) and whose
 * HLA term was washed out by dividing by SCALE^2 with no separate weight
 * (any HLA difference under ~71 percentage points rounded to 0). Both are
 * fixed here: blood compatibility is now real ABO/Rh, and HLA gets its own
 * HLA_WEIGHT so differences actually move the score. This is a *lower* raw
 * distance = better match; see src/utils/pfe.js's toCompatibilityScore()
 * for the 1000-minus-distance conversion used for display/ranking.
 *
 * The 3-way ABO/Rh sum below is built from 3 *independent* single-level
 * homomorphic multiplications added together (no ciphertext multiplied by
 * another ciphertext-derived result) — same multiplicative depth as the
 * original scheme, verified empirically to decrypt correctly with the
 * unchanged BFV parameters above (see PROGRESS notes / commit history for
 * the verification script and its results).
 *
 * SECURITY: masterSecret is generated once at startup and NEVER logged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SEAL     = require('node-seal');
const crypto   = require('crypto');
const { hkdf } = require('crypto');
const { promisify } = require('util');

const hkdfAsync = promisify(hkdf);

// ── Polynomial weight coefficients (kidney transplant model) ─────────────────
const ALPHA = [
  50,   // α0: base constant        (0.05 × 1000)
  400,  // α1: blood type weight    (0.40 × 1000)
  300,  // α2: HLA match weight     (0.30 × 1000)
  150,  // α3: urgency weight       (0.15 × 1000)
  50,   // α4: blood × HLA cross    (0.05 × 1000)
  50,   // α5: HLA × urgency cross  (0.05 × 1000)
];

// SCALE factor for integer encoding. Widened from 10 -> 20 so HLA-score
// differences are quantised into 21 levels (5% granularity) rather than 10
// (verified this stays well within the plaintext modulus and noise budget
// for the formula below — see the header comment).
const SCALE = 20;

// Weight applied to the HLA-difference term, analogous to W for blood.
// Without an explicit weight, (diff)^2 is naturally in [0,1] and always
// rounds to 0 or 1 after the final /SCALE^2 descale — this makes real HLA
// differences (e.g. 2% vs 70%) actually move the score.
const HLA_WEIGHT = 300;

// Blood type index -> [isA, isB, isRhPos]. Index order matches BLOOD_TYPES
// in DonorRegister.jsx/RecipientRegister.jsx: 0=A+ 1=A- 2=B+ 3=B- 4=AB+
// 5=AB- 6=O+ 7=O-. Used to evaluate real ABO/Rh donor->recipient
// compatibility homomorphically instead of a same/different proxy.
const BLOOD_DECOMPOSE = [
  [1, 0, 1], // A+
  [1, 0, 0], // A-
  [0, 1, 1], // B+
  [0, 1, 0], // B-
  [1, 1, 1], // AB+
  [1, 1, 0], // AB-
  [0, 0, 1], // O+
  [0, 0, 0], // O-
];

// BFV parameters
const POLY_MODULUS_DEGREE = 4096;
const PLAIN_MODULUS       = 786433;

// ── Module-level SEAL state ──────────────────────────────────────────────────
let sealInstance  = null;
let context       = null;
let keyGenerator  = null;
let publicKey     = null;
let secretKey     = null;
let encryptor     = null;
let decryptor     = null;
let evaluator     = null;
let batchEncoder  = null;
let masterSecret  = null;

/**
 * Initialise the SEAL context, key generator, encryptor, decryptor, evaluator.
 * Must be awaited before any other PFE operation.
 */
async function initPFE() {
  if (sealInstance) return; // already initialised

  sealInstance = await SEAL();

  const schemeType       = sealInstance.SchemeType.bfv;
  const securityLevel    = sealInstance.SecurityLevel.tc128;
  const params           = sealInstance.EncryptionParameters(schemeType);

  params.setPolyModulusDegree(POLY_MODULUS_DEGREE);

  // Set coefficient modulus suitable for BFV at degree 4096
  params.setCoeffModulus(
    sealInstance.CoeffModulus.BFVDefault(POLY_MODULUS_DEGREE, securityLevel)
  );

  // Set plain modulus — must be a prime congruent to 1 mod 2*degree (20 bits gives plenty of noise budget for 1 mult)
  params.setPlainModulus(
    sealInstance.PlainModulus.Batching(POLY_MODULUS_DEGREE, 20)
  );

  context     = sealInstance.Context(params, true, securityLevel);
  keyGenerator = sealInstance.KeyGenerator(context);
  secretKey   = keyGenerator.secretKey();
  publicKey   = keyGenerator.createPublicKey();
  
  // Generate relinearization keys for multiplication
  const relinKeysObj = keyGenerator.createRelinKeys();
  global.relinKeys = relinKeysObj;

  encryptor   = sealInstance.Encryptor(context, publicKey);
  decryptor   = sealInstance.Decryptor(context, secretKey);
  evaluator   = sealInstance.Evaluator(context);
  batchEncoder = sealInstance.BatchEncoder(context);

  // Generate master secret for key derivation — NEVER logged
  masterSecret = crypto.randomBytes(32);

  console.log('[PFE] SEAL BFV context initialised (polyDeg=%d)', POLY_MODULUS_DEGREE);
}

/**
 * Encode a single integer value into a SEAL plaintext (fills all slots with
 * the same value for batch operations, or uses slot 0 for scalar operations).
 *
 * @param {number} value  Integer value to encode.
 * @returns {object}      SEAL PlainText object.
 */
function encodeScalar(value) {
  const slotCount = batchEncoder.slotCount;
  const array     = new BigInt64Array(slotCount).fill(BigInt(Math.round(value)));
  const plain     = sealInstance.PlainText();
  batchEncoder.encode(array, plain);
  return plain;
}

/**
 * Encrypt a single scaled integer attribute.
 *
 * @param {number} value  Raw value (0–1 float or 0/1 binary).
 * @returns {string}      Base64-encoded BFV ciphertext.
 */
function encryptScalar(value) {
  const scaled  = Math.round(value * SCALE);
  const plain   = encodeScalar(scaled);
  const cipher  = sealInstance.CipherText();
  encryptor.encrypt(plain, cipher);
  plain.delete();
  const b64 = Buffer.from(cipher.save()).toString('base64');
  cipher.delete();
  return b64;
}

/**
 * Encrypt donor/recipient attributes into BFV ciphertexts.
 *
 * @param {number} bloodTypeIndex  Blood type index 0-7 (see BLOOD_DECOMPOSE) —
 *                                 the actual category, NOT a pre-binarized bit.
 * @param {number} hlaScore        HLA antigen match score (0.0–1.0).
 * @param {number} urgency         Urgency level (0.0–1.0).
 * @returns {{ ctIsA, ctIsB, ctIsRhPos, ctHla, ctUrgency }}  Base64 ciphertexts.
 */
function encryptAttributes(bloodTypeIndex, hlaScore, urgency) {
  if (!sealInstance) throw new Error('PFE not initialised. Call initPFE() first.');
  const decomposition = BLOOD_DECOMPOSE[bloodTypeIndex];
  if (!decomposition) throw new Error(`Invalid bloodTypeIndex: ${bloodTypeIndex} (expected 0-7)`);
  const [isA, isB, isRhPos] = decomposition;
  return {
    ctIsA:     encryptScalar(isA),
    ctIsB:     encryptScalar(isB),
    ctIsRhPos: encryptScalar(isRhPos),
    ctHla:     encryptScalar(hlaScore),
    ctUrgency: encryptScalar(urgency),
  };
}

/**
 * Deserialise a base64 ciphertext back into a SEAL CipherText object.
 */
function loadCipherText(b64) {
  const buf    = Buffer.from(b64, 'base64');
  const cipher = sealInstance.CipherText();
  cipher.load(context, buf);
  return cipher;
}

/**
 * Given two encrypted 0/1 flags (each SCALE-scaled at encryption time),
 * homomorphically compute donorFlag AND (NOT recipFlag) — i.e. "donor has
 * this antigen but recipient doesn't", one incompatibility indicator.
 * Costs exactly one ciphertext-ciphertext multiplication (same depth as the
 * squared-difference terms elsewhere in this file).
 *
 * @returns {object}  SEAL CipherText, SCALE^2-scaled, representing 0 or 1.
 */
function computeIncompatibility(donorFlagCt, recipFlagCt) {
  const scalePlain = encodeScalar(SCALE);
  const oneMinusRecip = sealInstance.CipherText();
  evaluator.negate(recipFlagCt, oneMinusRecip);
  evaluator.addPlain(oneMinusRecip, scalePlain, oneMinusRecip);
  scalePlain.delete();

  const product = sealInstance.CipherText();
  evaluator.multiply(donorFlagCt, oneMinusRecip, product);
  evaluator.relinearize(product, global.relinKeys, product);
  oneMinusRecip.delete();
  return product;
}

/**
 * Compute encrypted compatibility score using homomorphic evaluation.
 *
 * Math: score = HLA_WEIGHT * (donor.hla - recipient.hla)^2
 *             + W * [ isA_d*(1-isA_r) + isB_d*(1-isB_r) + isRh_d*(1-isRh_r) ]
 *
 * The bracketed term is real ABO/Rh donor->recipient compatibility (0 =
 * fully compatible, up to 3 = incompatible on every antigen) — see the
 * file header comment for why this replaced a cruder same/different check,
 * and why HLA needs its own weight. Lower score = better match (this is a
 * dissimilarity distance, not a compatibility score — see
 * src/utils/pfe.js's toCompatibilityScore() for the conversion used by the
 * UI). All arithmetic is performed in the encrypted domain via BFV evaluator.
 *
 * @param {object} donorCts   Donor ciphertexts { ctIsA, ctIsB, ctIsRhPos, ctHla }
 * @param {object} recipCts   Recipient ciphertexts { ctIsA, ctIsB, ctIsRhPos, ctHla }
 * @param {number} W          Weight per incompatible antigen (default: 100)
 * @returns {string}          Base64-encoded encrypted result.
 */
function computeCompatibilityScore(donorCts, recipCts, W = 100) {
  if (!sealInstance) throw new Error('PFE not initialised.');

  const dIsA = loadCipherText(donorCts.ctIsA);
  const dIsB = loadCipherText(donorCts.ctIsB);
  const dRh  = loadCipherText(donorCts.ctIsRhPos);
  const dHla = loadCipherText(donorCts.ctHla);
  const rIsA = loadCipherText(recipCts.ctIsA);
  const rIsB = loadCipherText(recipCts.ctIsB);
  const rRh  = loadCipherText(recipCts.ctIsRhPos);
  const rHla = loadCipherText(recipCts.ctHla);

  // 1. Real ABO/Rh incompatibility sum (3 independent single-level mults)
  const aIncompat  = computeIncompatibility(dIsA, rIsA);
  const bIncompat  = computeIncompatibility(dIsB, rIsB);
  const rhIncompat = computeIncompatibility(dRh, rRh);

  const bloodSum = sealInstance.CipherText();
  evaluator.add(aIncompat, bIncompat, bloodSum);
  evaluator.add(bloodSum, rhIncompat, bloodSum);

  const plainW = encodeScalar(W);
  const bloodSumW = sealInstance.CipherText();
  evaluator.multiplyPlain(bloodSum, plainW, bloodSumW);
  plainW.delete();

  // 2. Weighted HLA squared-difference
  const diffHla = sealInstance.CipherText();
  evaluator.sub(dHla, rHla, diffHla);
  const diffHlaSq = sealInstance.CipherText();
  evaluator.multiply(diffHla, diffHla, diffHlaSq);
  evaluator.relinearize(diffHlaSq, global.relinKeys, diffHlaSq);

  const plainHlaWeight = encodeScalar(HLA_WEIGHT);
  const diffHlaSqW = sealInstance.CipherText();
  evaluator.multiplyPlain(diffHlaSq, plainHlaWeight, diffHlaSqW);
  plainHlaWeight.delete();

  // 3. score = diffHlaSqW + bloodSumW
  const score = sealInstance.CipherText();
  evaluator.add(diffHlaSqW, bloodSumW, score);

  // Cleanup intermediate ciphertexts
  [dIsA, dIsB, dRh, dHla, rIsA, rIsB, rRh, rHla,
   aIncompat, bIncompat, rhIncompat, bloodSum, bloodSumW,
   diffHla, diffHlaSq, diffHlaSqW].forEach(ct => ct.delete());

  const b64 = Buffer.from(score.save()).toString('base64');
  score.delete();
  return b64;
}

/**
 * Decrypt a BFV ciphertext and return the integer score from slot 0.
 *
 * @param {string} encryptedScoreB64  Base64-encoded BFV ciphertext.
 * @returns {number}                  Decrypted integer score.
 */
function decryptScore(encryptedScoreB64) {
  if (!sealInstance) throw new Error('PFE not initialised.');

  const cipher = loadCipherText(encryptedScoreB64);
  const plain  = sealInstance.PlainText();
  decryptor.decrypt(cipher, plain);

  const decoded = batchEncoder.decode(plain, false);
  cipher.delete();
  plain.delete();

  // Score is in slot 0 — divide by SCALE^2 due to one homomorphic multiplication
  // per term. This is a raw dissimilarity distance (0 = perfect match), not
  // a compatibility score — see src/utils/pfe.js's toCompatibilityScore().
  const rawScore = Number(decoded[0]);
  const normScore = Math.round(rawScore / (SCALE * SCALE));
  return Math.max(0, Math.min(1000, normScore));
}

// ── Role-scoped key derivation ───────────────────────────────────────────────

/**
 * Derive a role-scoped AES-256 key via HKDF-SHA256.
 * Key material is bound to roleId + keyCommitment so each role gets a unique key.
 *
 * SECURITY: masterSecret is in memory only, never persisted or logged.
 *
 * @param {number} roleId          Role identifier (0–5).
 * @param {string} keyCommitment   Hex-encoded key commitment from PFEKeyIssuer.
 * @returns {Promise<Buffer>}      32-byte AES-256 key material.
 */
async function issueRoleScopedKey(roleId, keyCommitment) {
  if (!masterSecret) throw new Error('PFE not initialised.');

  // info = roleId (1 byte) || keyCommitment (32 bytes as hex → 32 bytes)
  const commitBuf = Buffer.from(keyCommitment.replace('0x', ''), 'hex');
  const info      = Buffer.concat([Buffer.from([roleId & 0xff]), commitBuf]);

  const derivedKey = await hkdfAsync(
    'sha256',
    masterSecret,
    Buffer.alloc(0), // no salt (master secret already random)
    info,
    32               // 32 bytes = AES-256
  );

  return Buffer.from(derivedKey);
}

/**
 * Encrypt data using AES-256-GCM with the provided role key.
 *
 * @param {Buffer|string} data   Plaintext data to encrypt.
 * @param {Buffer}        key    32-byte AES-256 key.
 * @returns {string}             Base64-encoded: iv(12) || authTag(16) || ciphertext.
 */
function encryptWithRoleKey(data, key) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const buf    = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const ct     = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt AES-256-GCM data encrypted with encryptWithRoleKey.
 *
 * @param {string} encryptedB64  Base64-encoded encrypted payload.
 * @param {Buffer} key           32-byte AES-256 key.
 * @returns {Buffer}             Decrypted plaintext.
 */
function decryptWithRoleKey(encryptedB64, key) {
  const buf    = Buffer.from(encryptedB64, 'base64');
  const iv     = buf.subarray(0, 12);
  const tag    = buf.subarray(12, 28);
  const ct     = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Compute the encrypted record for a full donor/recipient attribute set.
 * Encrypts all attributes and then AES-wraps the ciphertext bundle.
 *
 * @param {{ bloodType, hlaScore, urgency }} attrs   Raw attributes
 *                                                   (bloodType is the 0-7 index).
 * @param {Buffer}                            roleKey  AES role key.
 * @returns {{ ciphertexts, encryptedRecord }}
 */
function prepareEncryptedRecord(attrs, roleKey) {
  if (!sealInstance) throw new Error('PFE not initialised.');

  const ciphertexts = encryptAttributes(
    attrs.bloodType,
    attrs.hlaScore,
    attrs.urgency
  );

  const bundle          = JSON.stringify({ ...ciphertexts, ts: Date.now() });
  const encryptedRecord = encryptWithRoleKey(bundle, roleKey);

  return {
    ciphertexts,
    encryptedRecord,
  };
}

module.exports = {
  initPFE,
  encryptAttributes,
  computeCompatibilityScore,
  decryptScore,
  issueRoleScopedKey,
  encryptWithRoleKey,
  decryptWithRoleKey,
  prepareEncryptedRecord,
};
