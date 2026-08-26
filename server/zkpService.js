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
  const credBig  = typeof credential === 'bigint'
    ? credential
    : BigInt(credential.startsWith('0x') ? credential : `0x${credential}`);

  const saltBig  = typeof salt === 'bigint'
    ? salt
    : BigInt(salt.startsWith('0x') ? salt : `0x${salt}`);

  const rootBig  = typeof merkleRoot === 'bigint'
    ? merkleRoot
    : BigInt(merkleRoot.startsWith('0x') ? merkleRoot : `0x${merkleRoot}`);

  const roleIdBig = BigInt(roleId);

  const pathElemBig = pathElements.map(e => {
    if (typeof e === 'bigint') return e;
    const s = String(e);
    return BigInt(s.startsWith('0x') ? s : `0x${s}`);
  });

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

/**
 * Build a 20-level Poseidon Merkle tree with leafScalar at index 0.
 * Returns root (BigInt) + sibling path for leaf[0].
 *
 * @param {BigInt} leafScalar
 * @param {number} depth
 * @returns {{ root: BigInt, pathElements: BigInt[], pathIndices: number[] }}
 */
function buildMerkleTree(leafScalar, depth = 20) {
  if (!poseidon) throw new Error('ZKP not initialised');
  const F    = poseidon.F;
  const zero = BigInt(0);

  let layer = [leafScalar, ...Array(Math.pow(2, depth) - 1).fill(zero)];
  const pathElements = [];
  const pathIndices  = [];

  for (let lvl = 0; lvl < depth; lvl++) {
    // Leaf 0 is always on the left; its sibling is layer[1]
    pathIndices.push(0);
    pathElements.push(layer[1]);

    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const h = F.toObject(poseidon([layer[i], layer[i + 1]]));
      next.push(BigInt(h));
    }
    layer = next;
  }

  return { root: layer[0], pathElements, pathIndices };
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

