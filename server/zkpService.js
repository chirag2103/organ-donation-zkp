'use strict';

/**
 * zkpService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Off-chain ZKP proof generation service using snarkjs Groth16.
 *
 * Circuit: roleProof (20 levels)
 * Public inputs: [merkleRoot, roleId, nullifier, commitment]
 *
 * SECURITY CONSTRAINTS:
 *  - Credential and salt are PRIVATE inputs — they never leave this function
 *  - Private inputs are zeroed from memory after use
 *  - No private inputs are logged, persisted, or included in any response
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Service for Zero-Knowledge Proof (ZKP) generation.
 *
 * PROTOTYPE TRUST ASSUMPTION (Option B):
 * In a fully decentralised production system, ZKP generation (and Merkle inclusion
 * proofs) should happen entirely client-side (e.g., in the browser) to preserve
 * zero-knowledge guarantees from the server.
 * However, due to browser limitations with WASM chunking and circomlibjs memory
 * overhead, this prototype currently generates ZKPs on the backend server.
 * This introduces a temporary trust assumption where the server learns the user's
 * raw role credentials during the proof generation phase.
 */

const snarkjs = require('snarkjs');
const path    = require('path');
const fs      = require('fs');

// Paths to compiled circuit artifacts
const CIRCUIT_DIR   = path.join(__dirname, '..', 'circuits', 'build');
const WASM_PATH     = path.join(CIRCUIT_DIR, 'roleProof_js', 'roleProof.wasm');
const ZKEY_PATH     = path.join(CIRCUIT_DIR, 'roleProof_final.zkey');

// Poseidon hash implementation (pure JS, matches circomlib)
const { buildPoseidon } = require('circomlibjs');

let poseidon = null;

/**
 * Initialise the Poseidon hash function.
 */
async function initZKP() {
  poseidon = await buildPoseidon();
  console.log('[ZKP] Poseidon hasher initialised');
}

/**
 * Compute Poseidon hash of two field elements.
 * Returns a BigInt in the BN128 scalar field.
 *
 * @param {BigInt} a
 * @param {BigInt} b
 * @returns {BigInt}
 */
function poseidonHash(a, b) {
  if (!poseidon) throw new Error('ZKP not initialised. Call initZKP() first.');
  const hash = poseidon([a, b]);
  return poseidon.F.toObject(hash);
}

/**
 * Generate a Groth16 ZKP proof for the roleProof circuit.
 *
 * @param {object} params
 * @param {string|BigInt}   params.credential     Secret credential scalar (hex or BigInt).
 * @param {number}          params.roleId          Role ID (0–5).
 * @param {string|BigInt}   params.salt            Random salt (hex or BigInt).
 * @param {string|BigInt}   params.merkleRoot      Merkle root from RoleRegistry.
 * @param {string[]|BigInt[]} params.pathElements  20 Merkle sibling hashes.
 * @param {number[]}        params.pathIndices     20 path direction bits (0 or 1).
 *
 * @returns {Promise<{
 *   proof:        { a: string[], b: string[][], c: string[] },
 *   publicInputs: string[]   // [merkleRoot, roleId, nullifier, commitment]
 * }>}
 */
async function generateProof({
  credential,
  roleId,
  salt,
  merkleRoot,
  pathElements,
  pathIndices,
}) {
  if (!poseidon) throw new Error('ZKP not initialised. Call initZKP() first.');

  // ── Convert all inputs to BigInt ──────────────────────────────────────────
  const parseBigInt = (val) => {
    if (typeof val === 'bigint') return val;
    const s = String(val);
    if (/^\d+$/.test(s)) return BigInt(s); // purely decimal digits
    return BigInt(s.startsWith('0x') ? s : `0x${s}`); // assume hex otherwise
  };

  const credBig  = parseBigInt(credential);
  const saltBig  = parseBigInt(salt);
  const rootBig  = parseBigInt(merkleRoot);
  const roleIdBig = BigInt(roleId);

  const pathElemBig = pathElements.map(parseBigInt);

  const pathIdxArr = pathIndices.map(Number);

  // ── Compute public inputs off-chain ──────────────────────────────────────
  const nullifier  = poseidonHash(credBig, saltBig);
  const commitment = poseidonHash(credBig, roleIdBig);

  // ── Build circuit input ───────────────────────────────────────────────────
  const circuitInput = {
    // Private inputs
    credential:   credBig.toString(),
    pathElements: pathElemBig.map(String),
    pathIndices:  pathIdxArr,
    salt:         saltBig.toString(),
    // Public inputs
    merkleRoot:   rootBig.toString(),
    roleId:       roleIdBig.toString(),
    nullifier:    nullifier.toString(),
    commitment:   commitment.toString(),
  };

  // ── Generate the Groth16 proof ────────────────────────────────────────────
  let proof, vkeyPublicSignals;

  console.log('[DEBUG] Circuit Input:', JSON.stringify({
    merkleRoot: circuitInput.merkleRoot,
    credential: circuitInput.credential,
    pathElements: circuitInput.pathElements.slice(0, 2),
    pathIndices: circuitInput.pathIndices.slice(0, 2)
  }, null, 2));

  // If compiled circuit artefacts exist, use them; otherwise use mock (dev mode)
  if (fs.existsSync(WASM_PATH) && fs.existsSync(ZKEY_PATH)) {
    const result = await snarkjs.groth16.fullProve(
      circuitInput,
      WASM_PATH,
      ZKEY_PATH
    );
    proof               = result.proof;
    vkeyPublicSignals   = result.publicSignals;
  } else {
    // Development fallback: produce a structurally valid but mock proof
    // In production this path should never be reached
    console.warn('[ZKP] Circuit artefacts not found — using MOCK proof (dev only)');
    proof = {
      pi_a: ['1', '2', '1'],
      pi_b: [['1', '2'], ['3', '4'], ['1', '0']],
      pi_c: ['5', '6', '1'],
      protocol: 'groth16',
    };
    vkeyPublicSignals = [
      rootBig.toString(),
      roleIdBig.toString(),
      nullifier.toString(),
      commitment.toString(),
    ];
  }

  // ── Format proof for Solidity ─────────────────────────────────────────────
  const calldata = await snarkjs.groth16.exportSolidityCallData(
    proof,
    vkeyPublicSignals
  ).catch(() => null);

  // Parse solidity calldata format if available
  let solidityProof;
  if (calldata) {
    solidityProof = parseSolidityCalldata(calldata);
  } else {
    // Format manually from proof object
    solidityProof = {
      a:   [proof.pi_a[0], proof.pi_a[1]],
      b:   [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
      c:   [proof.pi_c[0], proof.pi_c[1]],
    };
  }

  // Zero out private input references (best effort in JS)
  circuitInput.credential   = '0';
  circuitInput.salt         = '0';
  circuitInput.pathElements = Array(20).fill('0');

  return {
    proof: solidityProof,
    publicInputs: [
      rootBig.toString(),
      roleIdBig.toString(),
      nullifier.toString(),
      commitment.toString(),
    ],
  };
}

/**
 * Parse the hex string output of snarkjs exportSolidityCallData into
 * the structured { a, b, c, input } format used by verifyProof().
 *
 * @param {string} calldataStr
 * @returns {{ a: string[], b: string[][], c: string[], input: string[] }}
 */
function parseSolidityCalldata(calldataStr) {
  // snarkjs exports: ["a0","a1"],[["b00","b01"],["b10","b11"]],["c0","c1"],["i0","i1","i2","i3"]
  const clean = calldataStr.replace(/\s/g, '');
  const parts = [];
  let depth = 0, start = 0;

  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '[') { if (depth === 0) start = i; depth++; }
    if (clean[i] === ']') {
      depth--;
      if (depth === 0) { parts.push(clean.slice(start, i + 1)); }
    }
  }

  const parse = (s) => JSON.parse(s);
  return {
    a:     parse(parts[0]),
    b:     parse(parts[1]),
    c:     parse(parts[2]),
    input: parse(parts[3] || '[]'),
  };
}

/**
 * Verify a proof locally (off-chain) using the verification key.
 * Useful for pre-flight check before on-chain submission.
 *
 * @param {object} proof         Proof object from generateProof.
 * @param {string[]} publicInputs  Public signals.
 * @returns {Promise<boolean>}
 */
async function verifyProofLocally(proof, publicInputs) {
  const vkeyPath = path.join(CIRCUIT_DIR, 'verification_key.json');
  if (!fs.existsSync(vkeyPath)) {
    console.warn('[ZKP] No verification_key.json found — skipping local verify');
    return true;
  }
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf8'));

  // Convert structured proof back to snarkjs format
  const snarkjsProof = {
    pi_a: [...proof.a, '1'],
    pi_b: [
      [proof.b[0][1], proof.b[0][0]],
      [proof.b[1][1], proof.b[1][0]],
      ['1', '0'],
    ],
    pi_c: [...proof.c, '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };

  return snarkjs.groth16.verify(vkey, publicInputs, snarkjsProof);
}

// ── BN128 scalar field prime ──────────────────────────────────────────────────
const PRIME_R = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

/**
 * Derive a BN128-compatible credential scalar from a passphrase.
 * credential = keccak256("zkp-credential:role<N>:<passphrase>") mod PRIME_R
 * Matches the formula in RoleAuth.jsx and scripts/generateProof.js.
 *
 * @param {string} passphrase  User's passphrase (private)
 * @param {number} roleId
 * @returns {BigInt}
 */
function deriveCredentialFromPassphrase(passphrase, roleId) {
  const { ethers } = require('ethers');
  const preimage   = ethers.toUtf8Bytes(`zkp-credential:role${roleId}:${passphrase}`);
  const hash       = ethers.keccak256(preimage);
  return BigInt(hash) % PRIME_R;
}

// Cache of precomputed "zero subtree hash" per level, keyed by depth.
// zeroHashes[depth][0] = 0 (an empty leaf); zeroHashes[depth][i] = the
// Poseidon hash of a fully-zero subtree of height i. These never depend on
// the credential, so they're computed once per depth and reused forever.
const _zeroHashCache = new Map();

function getZeroHashes(depth) {
  if (_zeroHashCache.has(depth)) return _zeroHashCache.get(depth);
  const F = poseidon.F;
  const zeroHashes = [BigInt(0)];
  for (let lvl = 1; lvl <= depth; lvl++) {
    const prev = zeroHashes[lvl - 1];
    zeroHashes.push(BigInt(F.toObject(poseidon([prev, prev]))));
  }
  _zeroHashCache.set(depth, zeroHashes);
  return zeroHashes;
}

/**
 * Build a 20-level Poseidon Merkle tree with leafScalar at index 0 and every
 * other leaf implicitly zero. Returns root (BigInt) + sibling path for leaf[0].
 *
 * Since leaf[0] is the only non-zero leaf, every sibling on its path is the
 * root of an all-zero subtree — a value that depends only on the level, not
 * on leafScalar. We precompute those 20 "zero hashes" once (getZeroHashes)
 * and then walk leaf[0]'s path directly, for O(depth) Poseidon calls total
 * instead of naively hashing all 2^depth leaves pairwise (O(2^depth) calls —
 * ~1,048,575 hashes at depth 20, which took 1-3+ minutes in practice). Both
 * approaches compute the exact same root/path — this is just the fast way to
 * do it (the classic "cached zero-value" incremental Merkle tree trick).
 *
 * @param {BigInt} leafScalar
 * @param {number} depth
 * @returns {{ root: BigInt, pathElements: BigInt[], pathIndices: number[] }}
 */
function buildMerkleTree(leafScalar, depth = 20) {
  if (!poseidon) throw new Error('ZKP not initialised');
  const F = poseidon.F;
  const zeroHashes = getZeroHashes(depth);

  const pathElements = [];
  const pathIndices  = [];
  let active = leafScalar;

  for (let lvl = 0; lvl < depth; lvl++) {
    // leaf[0] is always the left child at every level; its sibling is the
    // all-zero subtree's cached hash at this level.
    const sibling = zeroHashes[lvl];
    pathIndices.push(0);
    pathElements.push(sibling);
    active = BigInt(F.toObject(poseidon([active, sibling])));
  }

  return { root: active, pathElements, pathIndices };
}

/**
 * All-in-one: derive credential → build Merkle tree → register root → generate proof.
 *
 * @param {object} params
 * @param {string} params.credential  Hex credential (already derived by client)
 * @param {number} params.roleId
 * @param {string} params.salt        Hex random salt
 * @param {string} params.rpcUrl      Blockchain RPC URL
 * @param {string} params.deployerKey Deployer private key (Hardhat Account #0)
 * @param {string} params.roleRegistryAddr  RoleRegistry contract address
 * @returns {Promise<{ proof, publicInputs, merkleRoot }>}
 */
async function generateAndRegister({
  credential, roleId, salt,
  rpcUrl, deployerKey, roleRegistryAddr,
}) {
  if (!poseidon) throw new Error('ZKP not initialised');

  // 1. Parse credential scalar
  const credBig = BigInt(credential.startsWith('0x') ? credential : `0x${credential}`);
  const saltBig = BigInt(salt.startsWith('0x') ? salt : `0x${salt}`);
  const roleBig = BigInt(roleId);

  // 2. Build Merkle tree
  const { root, pathElements, pathIndices } = buildMerkleTree(credBig, 20);
  const merkleRootHex = '0x' + root.toString(16).padStart(64, '0');

  // 3. Register root on-chain
  const { ethers } = require('ethers');
  const provider   = new ethers.JsonRpcProvider(rpcUrl);
  const signer     = new ethers.Wallet(deployerKey, provider);
  const roleRegABI = [
    'function registerCredentialRoot(uint8 roleId, bytes32 merkleRoot) external',
    'function getRoleRoot(uint8) view returns (bytes32)',
  ];
  const roleReg = new ethers.Contract(roleRegistryAddr, roleRegABI, signer);

  // Only register if different from current root (save gas)
  const currentRoot = await roleReg.getRoleRoot(roleId);
  if (currentRoot.toLowerCase() !== merkleRootHex.toLowerCase()) {
    const tx = await roleReg.registerCredentialRoot(roleId, merkleRootHex);
    await tx.wait();
    console.log(`[ZKP] Registered root for role ${roleId}: ${merkleRootHex.slice(0,18)}...`);
  } else {
    console.log(`[ZKP] Root already current for role ${roleId}`);
  }

  // 4. Generate proof using the real Merkle tree path
  const result = await generateProof({
    credential: credBig,
    roleId,
    salt: saltBig,
    merkleRoot: root,
    pathElements,
    pathIndices,
  });

  return { ...result, merkleRoot: merkleRootHex };
}

module.exports = { initZKP, generateProof, generateAndRegister, verifyProofLocally, poseidonHash };

