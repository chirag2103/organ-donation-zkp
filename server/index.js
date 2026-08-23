'use strict';

/**
 * server/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express API server for the ZKP-Authenticated PFE-Gated Organ Donation System.
 *
 * Endpoints:
 *   POST /api/zkp/generate       — Off-chain proof generation
 *   POST /api/pfe/encrypt        — Encrypt donor/recipient attributes
 *   POST /api/pfe/score          — Compute encrypted compatibility score
 *   POST /api/pfe/decrypt        — Decrypt score with role key
 *   POST /api/ipfs/upload        — Upload encrypted record to IPFS
 *   DELETE /api/ipfs/unpin/:cid  — GDPR Article 17 erasure
 *   GET  /api/status             — Health check
 *
 * SECURITY:
 *   - Credentials and private inputs are NEVER logged
 *   - Master secret is in-memory only
 *   - CORS is restricted to configured origins
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { ethers }  = require('ethers');
const path        = require('path');
const fs          = require('fs');

const zkpService  = require('./zkpService');
const pfeService  = require('./pfeService');
const ipfsService = require('./ipfsService');

// ── App setup ──────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '5mb' }));

// Rate limiting — prevent brute-force ZKP submission
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      100,
  message:  { error: 'Too many requests — please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api/', apiLimiter);

// ── Load deployment addresses ──────────────────────────────────────────────
function loadDeployments() {
  const p = path.join(__dirname, '..', 'deployments', 'localhost.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── ZKP endpoint ─────────────────────────────────────────────────────────
/**
 * POST /api/zkp/generate
 * Body: { credential, roleId, salt, merkleRoot, pathElements[20], pathIndices[20] }
 * Response: { proof: { a, b, c }, publicInputs }
 *
 * SECURITY: credential and salt are private — response contains ONLY proof + publicInputs.
 */
app.post('/api/zkp/generate', async (req, res) => {
  const { credential, roleId, salt, merkleRoot, pathElements, pathIndices } = req.body;

  // Validate required fields
  if (!credential || roleId === undefined || !salt || !merkleRoot ||
      !Array.isArray(pathElements) || !Array.isArray(pathIndices)) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (pathElements.length !== 20 || pathIndices.length !== 20) {
    return res.status(400).json({ error: 'pathElements and pathIndices must have 20 elements' });
  }
  if (typeof roleId !== 'number' || roleId < 0 || roleId > 5) {
    return res.status(400).json({ error: 'roleId must be 0–5' });
  }

  try {
    const result = await zkpService.generateProof({
      credential,
      roleId,
      salt,
      merkleRoot,
      pathElements,
      pathIndices,
    });
    res.json(result);
  } catch (err) {
    console.error('[ZKP] Proof generation error:', err.message);
    res.status(500).json({ error: 'Proof generation failed', detail: err.message });
  }
});

// ── PFE encrypt endpoint ──────────────────────────────────────────────────
/**
 * POST /api/pfe/encrypt
 * Body: { bloodType (0–1), hlaScore (0.0–1.0), urgency (0.0–1.0) }
 * Response: { ciphertexts: [base64, base64, base64], encryptedRecord: base64 }
 */
app.post('/api/pfe/encrypt', async (req, res) => {
  const { bloodType, hlaScore, urgency, roleId, keyCommitment } = req.body;

  if (bloodType === undefined || hlaScore === undefined || urgency === undefined) {
    return res.status(400).json({ error: 'Missing bloodType, hlaScore, or urgency' });
  }
  if (typeof hlaScore !== 'number' || hlaScore < 0 || hlaScore > 1) {
    return res.status(400).json({ error: 'hlaScore must be 0.0–1.0' });
  }
  if (typeof urgency !== 'number' || urgency < 0 || urgency > 1) {
    return res.status(400).json({ error: 'urgency must be 0.0–1.0' });
  }
  // bloodType is 0 or 1 for compatibility (binary)
  const btNorm = bloodType > 0 ? 1 : 0;

  try {
    const { ct1, ct2, ct3 } = pfeService.encryptAttributes(btNorm, hlaScore, urgency);

    // Derive role key if provided (for AES wrapping)
    let encryptedRecord = null;
    if (roleId !== undefined && keyCommitment) {
      const roleKey     = await pfeService.issueRoleScopedKey(roleId, keyCommitment);
      const bundle      = JSON.stringify({ ct1, ct2, ct3, ts: Date.now() });
      encryptedRecord   = pfeService.encryptWithRoleKey(bundle, roleKey);
    }

    res.json({ ciphertexts: [ct1, ct2, ct3], encryptedRecord });
  } catch (err) {
    console.error('[PFE] Encrypt error:', err.message);
    res.status(500).json({ error: 'Encryption failed', detail: err.message });
  }
});

// ── PFE score endpoint ────────────────────────────────────────────────────
/**
 * POST /api/pfe/score
 * Body: { ct1, ct2, ct3, roleId, keyCommitment }
 * Response: { encryptedScore: base64 }
 */
app.post('/api/pfe/score', async (req, res) => {
  const { ct1, ct2, ct3, roleId, keyCommitment } = req.body;

  if (!ct1 || !ct2 || !ct3) {
    return res.status(400).json({ error: 'Missing ciphertexts ct1, ct2, ct3' });
  }

  try {
    const encryptedScore = pfeService.computeCompatibilityScore(ct1, ct2, ct3);
    res.json({ encryptedScore });
  } catch (err) {
    console.error('[PFE] Score error:', err.message);
    res.status(500).json({ error: 'Score computation failed', detail: err.message });
  }
});

// ── PFE decrypt endpoint ──────────────────────────────────────────────────
/**
 * POST /api/pfe/decrypt
 * Body: { encryptedScore: base64, roleId, keyCommitment }
 * Response: { score: number (0–1000) }
 */
app.post('/api/pfe/decrypt', async (req, res) => {
  const { encryptedScore, roleId, keyCommitment } = req.body;

  if (!encryptedScore || roleId === undefined || !keyCommitment) {
    return res.status(400).json({ error: 'Missing encryptedScore, roleId, or keyCommitment' });
  }

  try {
    const score = pfeService.decryptScore(encryptedScore);
    res.json({ score });
  } catch (err) {
    console.error('[PFE] Decrypt error:', err.message);
    res.status(500).json({ error: 'Decryption failed', detail: err.message });
  }
});

// ── IPFS upload endpoint ──────────────────────────────────────────────────
/**
 * POST /api/ipfs/upload
 * Body: { encryptedRecord: base64, donorId?: number }
 * Response: { cid: string }
 */
app.post('/api/ipfs/upload', async (req, res) => {
  const { encryptedRecord, donorId } = req.body;

  if (!encryptedRecord) {
    return res.status(400).json({ error: 'Missing encryptedRecord' });
  }

  try {
    const buf    = Buffer.from(encryptedRecord, 'base64');
    const result = await ipfsService.uploadEncryptedRecord(buf);

    // Register CID if donorId provided
    if (donorId !== undefined) {
      ipfsService.registerCID(donorId, result.cid);
    }

    res.json({ cid: result.cid });
  } catch (err) {
    console.error('[IPFS] Upload error:', err.message);
    res.status(500).json({ error: 'IPFS upload failed', detail: err.message });
  }
});

// ── IPFS unpin endpoint ───────────────────────────────────────────────────
/**
 * DELETE /api/ipfs/unpin/:cid
 * Response: { success: boolean }
 */
app.delete('/api/ipfs/unpin/:cid', async (req, res) => {
  const { cid } = req.params;
  if (!cid) return res.status(400).json({ error: 'Missing CID' });

  try {
    const result = await ipfsService.unpinRecord(cid);
    res.json(result);
  } catch (err) {
    console.error('[IPFS] Unpin error:', err.message);
    res.status(500).json({ error: 'Unpin failed', detail: err.message });
  }
});

// ── Status / health check ─────────────────────────────────────────────────
/**
 * GET /api/status
 * Response: { ipfs: bool, blockchain: bool, seal: bool }
 */
app.get('/api/status', async (req, res) => {
  const [ipfsOk, blockchainOk] = await Promise.all([
    ipfsService.checkIPFS(),
    (async () => {
      try {
        const deployments = loadDeployments();
        if (!deployments) return false;
        const provider = new ethers.JsonRpcProvider(
          process.env.RPC_URL || 'http://127.0.0.1:8545'
        );
        await provider.getBlockNumber();
        return true;
      } catch { return false; }
    })(),
  ]);

  res.json({
    ipfs:       ipfsOk,
    blockchain: blockchainOk,
    seal:       true, // SEAL is synchronously initialised at startup
    timestamp:  new Date().toISOString(),
  });
});

// ── 404 handler ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ── Error handler ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[SERVER] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────
async function start() {
  try {
    // Initialise services
    await zkpService.initZKP();
    await pfeService.initPFE();
    await ipfsService.initIPFS(process.env.IPFS_API_URL || 'http://127.0.0.1:5001');

    // Start blockchain event listener if deployment addresses exist
    const deployments = loadDeployments();
    if (deployments && deployments.LifecycleManager) {
      const provider = new ethers.JsonRpcProvider(
        process.env.RPC_URL || 'http://127.0.0.1:8545'
      );
      await ipfsService.startRevocationListener(
        provider,
        deployments.LifecycleManager
      );
    } else {
      console.warn('[SERVER] No deployment addresses found — revocation listener inactive');
    }

    app.listen(PORT, () => {
      console.log('[SERVER] ZKP Organ Donation API running on port %d', PORT);
    });
  } catch (err) {
    console.error('[SERVER] Startup failed:', err);
    process.exit(1);
  }
}

start();

module.exports = app; // export for testing
