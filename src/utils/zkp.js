/**
 * src/utils/zkp.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Browser-side ZKP helpers.
 *
 * Proof flow:
 *   generateRoleProof()      — Sends credential+passphrase to backend;
 *                              server builds the Merkle tree, generates the proof,
 *                              registers the root on-chain, and returns proof + publicInputs.
 *   formatProofForContract() — Shapes proof arrays for Solidity calldata.
 *   generateSalt()           — Cryptographically random 248-bit salt.
 *
 * NOTE: Merkle tree construction is server-side (requires circomlibjs which
 *       needs Node.js). Private inputs (credential, salt) are sent to the
 *       backend over the loopback proxy (never outside localhost in dev).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const API_BASE = import.meta.env.VITE_API_URL || '';
// empty string → relative URLs → Vite proxy forwards /api/* to localhost:3001

/**
 * Generate a Groth16 ZKP proof and register the Merkle root on-chain.
 * The backend:
 *   1. Derives credential from passphrase (same formula as deriveCredential())
 *   2. Builds a 20-level Poseidon Merkle tree with credential as leaf[0]
 *   3. Registers the root via RoleRegistry (deployer key)
 *   4. Generates the Groth16 proof
 *   5. Verifies locally
 *   6. Returns proof + publicInputs
 *
 * @param {object}  params
 * @param {string}  params.credential  Hex credential scalar (private)
 * @param {number}  params.roleId      Role ID 0–5
 * @param {string}  params.salt        Hex random salt (private)
 * @returns {Promise<{ proof: {a,b,c}, publicInputs: string[] }>}
 */
export async function generateRoleProof({ credential, roleId, salt }) {
  const response = await fetch(`${API_BASE}/api/zkp/generate-and-register`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ credential, roleId, salt }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`ZKP generation failed: ${err.error || response.statusText}`);
  }

  const result = await response.json();
  if (!result.proof || !result.publicInputs) {
    throw new Error('Invalid proof response from server');
  }
  return result;
}

/**
 * Format a proof object for on-chain Solidity calldata submission.
 * @param {{ a: string[], b: string[][], c: string[] }} proof
 * @returns {{ a, b, c }}
 */
export function formatProofForContract(proof) {
  return {
    a: proof.a.map(String),
    b: proof.b.map(row => row.map(String)),
    c: proof.c.map(String),
  };
}

/**
 * Generate a cryptographically random 248-bit salt (BN128 field safe).
 * @returns {string} 0x-prefixed hex string
 */
export function generateSalt() {
  const array = new Uint8Array(31);
  crypto.getRandomValues(array);
  return '0x' + Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}
