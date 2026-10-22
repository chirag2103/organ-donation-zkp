'use strict';

/**
 * ipfsService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * IPFS operations: upload encrypted records, download and decrypt, unpin.
 * Also starts a blockchain event listener for RevocationExecuted events to
 * automatically trigger IPFS unpinning.
 *
 * IPFS node: kubo daemon on localhost:5001 (ipfs-http-client v60+)
 * Blockchain: ethers.js v6 provider
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { ethers }  = require('ethers');
const pfeService  = require('./pfeService');

// ── IPFS client ───────────────────────────────────────────────────────────────
let ipfsClient = null;

/**
 * Initialise the IPFS HTTP client.
 * @param {string} apiUrl  IPFS API URL (default: http://127.0.0.1:5001).
 */
async function initIPFS(apiUrl = 'http://127.0.0.1:5001') {
  const { create } = await import('ipfs-http-client');
  ipfsClient = create({ url: apiUrl });
  console.log('[IPFS] Client initialised → %s', apiUrl);
}

/**
 * Check IPFS daemon connectivity.
 * @returns {Promise<boolean>}
 */
async function checkIPFS() {
  try {
    if (!ipfsClient) return false;
    // Use version() rather than id() — newer Kubo daemons advertise
    // webrtc-direct multiaddrs in their `id` response that this version of
    // ipfs-http-client's multiaddr parser doesn't recognise ("no protocol
    // with name: webrtc-direct"), which makes id() throw even though the
    // daemon (and add()/cat()) work fine. version() avoids multiaddr
    // parsing entirely and is a lighter connectivity check anyway.
    const v = await ipfsClient.version();
    return Boolean(v && v.version);
  } catch {
    return false;
  }
}

/**
 * Upload an encrypted record buffer to IPFS.
 *
 * @param {Buffer} encryptedBuffer  AES-encrypted record bytes.
 * @returns {Promise<{ cid: string }>}
 */
async function uploadEncryptedRecord(encryptedBuffer) {
  if (!ipfsClient) throw new Error('IPFS not initialised. Call initIPFS() first.');

  const result = await ipfsClient.add(encryptedBuffer, {
    pin: true,       // Pin immediately to prevent GC
    cidVersion: 1,   // Use CIDv1 (base32)
  });

  const cidStr = result.cid.toString();
  console.log('[IPFS] Uploaded encrypted record → CID: %s (%d bytes)',
    cidStr, encryptedBuffer.length);

  return { cid: cidStr };
}

/**
 * Download a record's raw bytes from IPFS, with no AES unwrapping.
 *
 * Used for donor/recipient PFE ciphertext bundles ({ ct1, ct2, ct3, ts }),
 * which are uploaded as plain JSON (see registerDonor/registerRecipient
 * flows) rather than AES-wrapped: their real confidentiality comes from the
 * SEAL BFV homomorphic encryption of ct1/ct2/ct3 themselves (unreadable
 * without the server's in-memory SEAL secret key), and access to *which*
 * CID to fetch is already gated on-chain via OrganRegistry's
 * onlyValidKey + hasPermission(viewScore) checks — so an extra ephemeral,
 * per-session AES layer here would only make records unreadable across
 * sessions/roles without adding any real access control of its own.
 *
 * @param {string} cidStr  IPFS CID string.
 * @returns {Promise<Buffer>}  Raw bytes as uploaded.
 */
async function downloadRawRecord(cidStr) {
  if (!ipfsClient) throw new Error('IPFS not initialised.');

  const chunks = [];
  for await (const chunk of ipfsClient.cat(cidStr)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Download and decrypt an AES-wrapped encrypted record from IPFS.
 *
 * @param {string} cidStr   IPFS CID string.
 * @param {Buffer} roleKey  32-byte AES-256 role key for decryption.
 * @returns {Promise<Buffer>}  Decrypted record buffer.
 */
async function downloadRecord(cidStr, roleKey) {
  if (!ipfsClient) throw new Error('IPFS not initialised.');

  const chunks = [];
  for await (const chunk of ipfsClient.cat(cidStr)) {
    chunks.push(Buffer.from(chunk));
  }
  const encryptedBuffer = Buffer.concat(chunks);

  const decrypted = pfeService.decryptWithRoleKey(
    encryptedBuffer.toString('base64'),
    roleKey
  );

  console.log('[IPFS] Downloaded and decrypted record from CID: %s', cidStr);
  return decrypted;
}

/**
 * Unpin a record from IPFS. After unpinning, the record will be garbage
 * collected by the IPFS daemon on the next GC cycle.
 *
 * This implements the GDPR Article 17 data erasure on the IPFS layer.
 *
 * @param {string} cidStr  IPFS CID to unpin.
 * @returns {Promise<{ success: boolean, cid: string, error?: string }>}
 */
async function unpinRecord(cidStr) {
  if (!ipfsClient) {
    return { success: false, cid: cidStr, error: 'IPFS not initialised' };
  }

  try {
    await ipfsClient.pin.rm(cidStr);
    // Trigger GC immediately to remove block data
    try {
      for await (const item of ipfsClient.repo.gc()) {
        // drain GC output
      }
    } catch (gcErr) {
      // GC failure is non-fatal
      console.warn('[IPFS] GC warning: %s', gcErr.message);
    }

    console.log('[IPFS] Unpinned CID: %s (GDPR Article 17 erasure)', cidStr);
    return { success: true, cid: cidStr };
  } catch (err) {
    // If already unpinned, treat as success
    if (err.message && err.message.includes('not pinned')) {
      console.log('[IPFS] CID %s was already unpinned', cidStr);
      return { success: true, cid: cidStr };
    }
    console.error('[IPFS] Unpin failed for %s: %s', cidStr, err.message);
    return { success: false, cid: cidStr, error: err.message };
  }
}

// ── Blockchain event listener ─────────────────────────────────────────────────
let revocationListenerActive = false;

/**
 * Start listening for RevocationExecuted events to automatically unpin data.
 * @param {string} lifecycleManagerAddr
 * @param {string} rpcUrl
 */
function startRevocationListener(lifecycleManagerAddr, rpcUrl) {
  if (revocationListenerActive) return;

  const { ethers } = require('ethers');
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const abi = [
    'event RevocationExecuted(uint256 indexed donorId, string cid, uint256 ts)'
  ];
  const lifecycleManager = new ethers.Contract(lifecycleManagerAddr, abi, provider);

  lifecycleManager.on('RevocationExecuted', async (donorId, cidHex, ts) => {
    const donorIdNum = donorId.toString();
    console.log('[IPFS] Detected RevocationExecuted for donor %s', donorIdNum);

    // Look up the actual IPFS CID from in-memory map (populated at upload time)
    const actualCid = cidRegistry.get(donorIdNum) || cidRegistry.get(cidHex) || cidHex;

    if (actualCid) {
      const result = await unpinRecord(actualCid);
      if (result.success) {
        console.log('[REVOCATION] Unpinned CID %s for donor %s', actualCid, donorIdNum);
      } else {
        console.error('[REVOCATION] Failed to unpin CID %s: %s', actualCid, result.error);
      }
    } else {
      console.warn('[REVOCATION] No IPFS CID found in registry for donor %s', donorIdNum);
    }
  });

  revocationListenerActive = true;
  console.log('[IPFS] Revocation listener active on LifecycleManager %s', lifecycleManagerAddr);
}

// ── In-memory CID registry (donorId → IPFS CID string) ───────────────────────
// In production this would be a persistent store (Redis, Postgres, etc.)
const cidRegistry = new Map();

/**
 * Register a CID in the in-memory registry after upload.
 * @param {string|number} donorId  Donor record ID.
 * @param {string}        cid      IPFS CID string.
 */
function registerCID(donorId, cid) {
  cidRegistry.set(String(donorId), cid);
  console.log('[IPFS] Registered CID %s for donor %s', cid, donorId);
}

/**
 * Retrieve a CID from the in-memory registry.
 * @param {string|number} donorId
 * @returns {string|undefined}
 */
function getCID(donorId) {
  return cidRegistry.get(String(donorId));
}

module.exports = {
  initIPFS,
  checkIPFS,
  uploadEncryptedRecord,
  downloadRecord,
  downloadRawRecord,
  unpinRecord,
  startRevocationListener,
  registerCID,
  getCID,
};
