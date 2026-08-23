/**
 * src/utils/pfe.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Browser-side PFE (Polynomial Functional Encryption) operations.
 * Wraps backend API calls for encryption, score computation, and decryption.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * Encrypt donor or recipient attributes via the PFE service.
 *
 * @param {{ bloodType: number, hlaScore: number, urgency: number }} attrs
 * @param {number} roleId           Role ID for key scoping.
 * @param {string} keyCommitment    Key commitment hex from PFEKeyIssuer.
 * @returns {Promise<{ ciphertexts: string[], encryptedRecord: string }>}
 */
export async function encryptAttributes(attrs, roleId, keyCommitment) {
  const response = await fetch(`${API_BASE}/api/pfe/encrypt`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      bloodType:     attrs.bloodType,
      hlaScore:      attrs.hlaScore,
      urgency:       attrs.urgency,
      roleId,
      keyCommitment,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Encryption failed: ${err.error || response.statusText}`);
  }

  return response.json();
}

/**
 * Compute an encrypted compatibility score using homomorphic evaluation.
 *
 * @param {string} ct1              Base64 ciphertext for blood type compatibility.
 * @param {string} ct2              Base64 ciphertext for HLA score.
 * @param {string} ct3              Base64 ciphertext for urgency.
 * @param {number} roleId           Role identifier.
 * @param {string} keyCommitment    Key commitment for access control.
 * @returns {Promise<{ encryptedScore: string }>}
 */
export async function computeScore(ct1, ct2, ct3, roleId, keyCommitment) {
  const response = await fetch(`${API_BASE}/api/pfe/score`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ct1, ct2, ct3, roleId, keyCommitment }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Score computation failed: ${err.error || response.statusText}`);
  }

  return response.json();
}

/**
 * Decrypt a compatibility score with the role key.
 *
 * @param {string} encryptedScore   Base64 BFV ciphertext.
 * @param {number} roleId           Role identifier.
 * @param {string} keyCommitment    Key commitment hex.
 * @returns {Promise<{ score: number }>}  Score in range 0–1000.
 */
export async function decryptScore(encryptedScore, roleId, keyCommitment) {
  const response = await fetch(`${API_BASE}/api/pfe/decrypt`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ encryptedScore, roleId, keyCommitment }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Decryption failed: ${err.error || response.statusText}`);
  }

  return response.json();
}

/**
 * Convert a 0–1000 score to a percentage and colour class.
 *
 * @param {number} score  Raw score 0–1000.
 * @returns {{ pct: number, colour: string, label: string }}
 */
export function interpretScore(score) {
  const pct = score / 10;
  let colour, label;

  if (pct >= 75)      { colour = '#22c55e'; label = 'Excellent match'; }
  else if (pct >= 50) { colour = '#f59e0b'; label = 'Good match'; }
  else if (pct >= 25) { colour = '#f97316'; label = 'Moderate match'; }
  else                 { colour = '#ef4444'; label = 'Poor match'; }

  return { pct, colour, label };
}
