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
 *        bloodType is the real 0-7 category index (see BLOOD_TYPES in
 *        DonorRegister.jsx) — the backend decomposes it into (isA, isB,
 *        isRhPos) for real ABO/Rh compatibility scoring.
 * @param {number} roleId           Role ID for key scoping.
 * @param {string} keyCommitment    Key commitment hex from PFEKeyIssuer.
 * @returns {Promise<{ ciphertexts: { ctIsA, ctIsB, ctIsRhPos, ctHla, ctUrgency }, encryptedRecord: string }>}
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
 * @param {object} donorCts         Donor ciphertexts { ctIsA, ctIsB, ctIsRhPos, ctHla }
 * @param {object} recipCts         Recipient ciphertexts { ctIsA, ctIsB, ctIsRhPos, ctHla }
 * @param {number} W                Weight per incompatible ABO/Rh antigen.
 * @param {number} roleId           Role identifier.
 * @param {string} keyCommitment    Key commitment for access control.
 * @returns {Promise<{ encryptedScore: string }>}
 */
export async function computeScore(donorCts, recipCts, W, roleId, keyCommitment) {
  const response = await fetch(`${API_BASE}/api/pfe/score`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ donorCts, recipCts, W, roleId, keyCommitment }),
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
 * decryptScore() / computeCompatibilityScore() return a *dissimilarity*
 * distance: score = (donor.hla - recip.hla)^2 + (donor.blood - recip.blood)^2 * W,
 * so 0 means "identical attributes" (a perfect match) and larger numbers
 * mean more different (this is deliberate — see
 * pfeService.integration.test.js's "should return 0 for a perfect match").
 *
 * For display/ranking we want the opposite convention (higher = better
 * compatibility, out of 1000), so this converts the raw distance into an
 * actual compatibility score. Always call this before interpretScore() or
 * before sorting a list of results by "best match".
 *
 * @param {number} rawDistance  Value returned by decryptScore() (0 = perfect).
 * @returns {number}            Compatibility score 0–1000 (1000 = perfect).
 */
export function toCompatibilityScore(rawDistance) {
  return Math.max(0, Math.min(1000, 1000 - rawDistance));
}

/**
 * Convert a 0–1000 *compatibility* score (higher = better — see
 * toCompatibilityScore()) to a percentage and colour class.
 *
 * @param {number} score  Compatibility score 0–1000 (NOT the raw distance).
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
