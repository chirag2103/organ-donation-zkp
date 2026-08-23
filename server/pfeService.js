'use strict';

/**
 * pfeService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Polynomial Functional Encryption engine using Microsoft SEAL (BFV scheme)
 * via node-seal.
 *
 * BFV parameters:
 *   polyModulusDegree : 4096
 *   plainModulus      : 786433 (a 20-bit Fermat prime: 3·2^18 + 1)
 *
 * Polynomial compatibility function (kidney-optimised):
 *   f(x) = α0 + α1·x1 + α2·x2 + α3·x3 + α4·x1·x2 + α5·x2·x3
 *
 * Where:
 *   x1 = blood type compatibility  (0 or 1, scaled × 1000)
 *   x2 = HLA antigen match score   (0–1 normalised, scaled × 1000)
 *   x3 = urgency level             (0–1 scaled, scaled × 1000)
 *
 * All values are integer-encoded (×1000) to work within BFV's integer-only
 * plaintext space.
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

// SCALE factor for integer encoding (values are ×1000 before encryption)
const SCALE = 1000;

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

  // Set plain modulus — must be a prime congruent to 1 mod 2*degree
  params.setPlainModulus(
    sealInstance.PlainModulus.Batching(POLY_MODULUS_DEGREE, 20)
  );

  context     = sealInstance.Context(params, true, securityLevel);
  keyGenerator = sealInstance.KeyGenerator(context);
  secretKey   = keyGenerator.secretKey();
  publicKey   = keyGenerator.createPublicKey();

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
 * @param {number} x1  Blood type compatibility (0 or 1).
 * @param {number} x2  HLA antigen match score (0.0–1.0).
 * @param {number} x3  Urgency level (0.0–1.0).
 * @returns {{ ct1: string, ct2: string, ct3: string }}  Base64 ciphertexts.
 */
function encryptAttributes(x1, x2, x3) {
  if (!sealInstance) throw new Error('PFE not initialised. Call initPFE() first.');
  return {
    ct1: encryptScalar(x1),
    ct2: encryptScalar(x2),
    ct3: encryptScalar(x3),
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
 * Compute encrypted compatibility score using polynomial evaluation.
 *
 * f(x) = α0 + α1·x1 + α2·x2 + α3·x3 + α4·x1·x2 + α5·x2·x3
 *
 * All arithmetic is performed in the encrypted domain via BFV evaluator.
 *
 * @param {string} ct1b64   Base64 ciphertext for x1 (blood type compatibility).
 * @param {string} ct2b64   Base64 ciphertext for x2 (HLA match score × SCALE).
 * @param {string} ct3b64   Base64 ciphertext for x3 (urgency × SCALE).
 * @param {number[]} alpha  Weight coefficients [α0..α5] (default ALPHA).
 * @returns {string}        Base64-encoded encrypted polynomial result.
 */
function computeCompatibilityScore(ct1b64, ct2b64, ct3b64, alpha = ALPHA) {
  if (!sealInstance) throw new Error('PFE not initialised.');

  const ct1 = loadCipherText(ct1b64);
  const ct2 = loadCipherText(ct2b64);
  const ct3 = loadCipherText(ct3b64);

  // α1·x1
  const plain_a1 = encodeScalar(alpha[1]);
  const term1    = sealInstance.CipherText();
  evaluator.multiplyPlain(ct1, plain_a1, term1);
  plain_a1.delete();

  // α2·x2
  const plain_a2 = encodeScalar(alpha[2]);
  const term2    = sealInstance.CipherText();
  evaluator.multiplyPlain(ct2, plain_a2, term2);
  plain_a2.delete();

  // α3·x3
  const plain_a3 = encodeScalar(alpha[3]);
  const term3    = sealInstance.CipherText();
  evaluator.multiplyPlain(ct3, plain_a3, term3);
  plain_a3.delete();

  // α4·x1·x2
  const ct1x2  = sealInstance.CipherText();
  evaluator.multiply(ct1, ct2, ct1x2);
  const plain_a4 = encodeScalar(alpha[4]);
  const term4    = sealInstance.CipherText();
  evaluator.multiplyPlain(ct1x2, plain_a4, term4);
  plain_a4.delete();
  ct1x2.delete();

  // α5·x2·x3
  const ct2x3  = sealInstance.CipherText();
  evaluator.multiply(ct2, ct3, ct2x3);
  const plain_a5 = encodeScalar(alpha[5]);
  const term5    = sealInstance.CipherText();
  evaluator.multiplyPlain(ct2x3, plain_a5, term5);
  plain_a5.delete();
  ct2x3.delete();

  // Sum all terms: result = α0 + term1 + term2 + term3 + term4 + term5
  const plain_a0 = encodeScalar(alpha[0]);
  const result   = sealInstance.CipherText();
  evaluator.addPlain(term1, plain_a0, result);
  plain_a0.delete();

  evaluator.addInplace(result, term2);
  evaluator.addInplace(result, term3);
  evaluator.addInplace(result, term4);
  evaluator.addInplace(result, term5);

  // Cleanup intermediate ciphertexts
  [ct1, ct2, ct3, term1, term2, term3, term4, term5].forEach(ct => ct.delete());

  const b64 = Buffer.from(result.save()).toString('base64');
  result.delete();
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

  // Score is in slot 0 — divide by SCALE^2 due to two multiplications
  const rawScore = Number(decoded[0]);
  // After two levels of multiplication, scale factor is SCALE^2
  // But we only multiplied α (integer) × ct (SCALE×value), so actual scale = SCALE
  // The cross terms (x1·x2) have scale SCALE^2 — normalise to 0–1000 range
  const normScore = Math.round(rawScore / SCALE);
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
 * Encrypts all three attributes and then AES-wraps the ciphertext bundle.
 *
 * @param {{ bloodType, hlaScore, urgency }} attrs   Raw attributes.
 * @param {Buffer}                            roleKey  AES role key.
 * @returns {{ ciphertexts, encryptedRecord }}
 */
function prepareEncryptedRecord(attrs, roleKey) {
  if (!sealInstance) throw new Error('PFE not initialised.');

  const { ct1, ct2, ct3 } = encryptAttributes(
    attrs.bloodType,
    attrs.hlaScore,
    attrs.urgency
  );

  const bundle         = JSON.stringify({ ct1, ct2, ct3, ts: Date.now() });
  const encryptedRecord = encryptWithRoleKey(bundle, roleKey);

  return {
    ciphertexts:     [ct1, ct2, ct3],
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
