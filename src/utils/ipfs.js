/**
 * src/utils/ipfs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Browser-side IPFS utility wrapping the backend IPFS API.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * Upload an encrypted record to IPFS via the backend service.
 *
 * @param {string}         encryptedRecord  Base64-encoded AES-GCM ciphertext.
 * @param {number|string}  donorId          Optional donor ID for CID registration.
 * @returns {Promise<{ cid: string }>}
 */
export async function uploadToIPFS(encryptedRecord, donorId) {
  const response = await fetch(`${API_BASE}/api/ipfs/upload`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ encryptedRecord, donorId }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`IPFS upload failed: ${err.error || response.statusText}`);
  }

  return response.json();
}

/**
 * Download a donor/recipient's raw PFE ciphertext bundle from IPFS.
 * Used by CompatibilityScore to score real registered records instead of
 * demo placeholder ciphertexts.
 *
 * @param {string} cid  IPFS CID string (from OrganRegistry's encCID field).
 * @returns {Promise<{ ct1: string, ct2: string, ct3: string, ts: number }>}
 */
export async function downloadFromIPFS(cid) {
  const response = await fetch(`${API_BASE}/api/ipfs/download/${encodeURIComponent(cid)}`);

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`IPFS download failed: ${err.error || response.statusText}`);
  }

  return response.json();
}

/**
 * Unpin a record from IPFS (GDPR Article 17 erasure).
 *
 * @param {string} cid  IPFS CID to unpin.
 * @returns {Promise<{ success: boolean }>}
 */
export async function unpinFromIPFS(cid) {
  const response = await fetch(`${API_BASE}/api/ipfs/unpin/${encodeURIComponent(cid)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`IPFS unpin failed: ${err.error || response.statusText}`);
  }

  return response.json();
}

/**
 * Convert a CID string to a bytes32 representation for on-chain storage.
 * keccak256 of the UTF-8 CID string.
 *
 * @param {string}        cidStr  IPFS CID string.
 * @param {ethers.utils}  ethers  ethers.js instance.
 * @returns {string}      bytes32 hex string.
 */
export function cidToBytes32(cidStr, ethers) {
  return ethers.keccak256(ethers.toUtf8Bytes(cidStr));
}

/**
 * Generate a gateway URL for an IPFS CID (for UI display).
 * Uses the public IPFS gateway — in production use a private gateway.
 *
 * @param {string} cid
 * @returns {string}
 */
export function getIPFSGatewayUrl(cid) {
  return `https://ipfs.io/ipfs/${cid}`;
}
