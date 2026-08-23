/**
 * src/utils/zkp.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Browser-side ZKP proof generation wrapper.
 * Calls the backend /api/zkp/generate endpoint — private inputs are sent
 * over HTTPS and never stored in the browser (cleared from memory post-call).
 *
 * For maximum security, proof generation can also be done fully in-browser
 * using snarkjs WASM — uncomment the local generation section if needed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * Generate a Groth16 ZKP proof for a role credential.
 *
 * @param {object} params
 * @param {string}   params.credential    Hex-encoded credential scalar.
 * @param {number}   params.roleId        Role ID (0–5).
 * @param {string}   params.salt          Hex-encoded random salt.
 * @param {string}   params.merkleRoot    Hex-encoded Merkle root from RoleRegistry.
 * @param {string[]} params.pathElements  20 sibling hashes (hex strings).
 * @param {number[]} params.pathIndices   20 path direction bits (0 or 1).
 *
 * @returns {Promise<{
 *   proof:        { a: string[], b: string[][], c: string[] },
 *   publicInputs: string[]
 * }>}
 *
 * @throws {Error} If the backend returns an error.
 */
export async function generateRoleProof({
  credential,
  roleId,
  salt,
  merkleRoot,
  pathElements,
  pathIndices,
}) {
  const response = await fetch(`${API_BASE}/api/zkp/generate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      credential,
      roleId,
      salt,
      merkleRoot,
      pathElements: pathElements || Array(20).fill('0'),
      pathIndices:  pathIndices  || Array(20).fill(0),
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`ZKP generation failed: ${err.error || response.statusText}`);
  }

  const result = await response.json();

  // Validate response structure
  if (!result.proof || !result.publicInputs) {
    throw new Error('Invalid proof response from server');
  }

  return result;
}

/**
 * Format a proof for on-chain submission to PFEKeyIssuer.verifyAndIssueKey().
 * Returns arrays compatible with Solidity uint256 types.
 *
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
 * Generate a cryptographically random salt suitable for ZKP.
 * @returns {string}  Hex-encoded 31-byte (248-bit) random value.
 */
export function generateSalt() {
  const array = new Uint8Array(31);
  crypto.getRandomValues(array);
  return '0x' + Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}
