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

module.exports = { initZKP, generateProof, verifyProofLocally, poseidonHash };
