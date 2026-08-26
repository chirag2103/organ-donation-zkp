'use strict';

/**
 * scripts/generateProof.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CLI tool to generate a valid Groth16 ZKP proof for the roleProof circuit.
 * Builds a real 20-level Poseidon Merkle tree with the credential as leaf[0]
 * so the Merkle constraint actually passes.
 *
 * Usage:
 *   node scripts/generateProof.js [--roleId 0] [--passphrase "your secret"]
 *
 * Output:
 *   proof.json  — proof + public inputs (private inputs are NOT saved)
 *
 * NOTE: In production, proof generation happens browser-side in the UI.
 *       This script is for CLI testing and development verification.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const snarkjs           = require('snarkjs');
const path              = require('path');
const fs                = require('fs');
const crypto            = require('crypto');
const { buildPoseidon } = require('circomlibjs');
const { ethers }        = require('ethers');

const BN128_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
const ROLE_NAMES  = ['DOCTOR','COORDINATOR','PROCUREMENT','MATCHING','TRANSPORTER','SURGEON'];

// ── Argument parsing ──────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const out  = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { out[args[i].slice(2)] = args[i + 1]; i++; }
  }
  return out;
}

/**
 * Derive a BN128-compatible credential scalar from a passphrase,
 * identical to the browser-side logic in RoleAuth.jsx.
 * credential = keccak256("zkp-credential:role<N>:<passphrase>") mod PRIME
 */
function deriveCredential(passphrase, roleId) {
  const preimage = Buffer.from(`zkp-credential:role${roleId}:${passphrase}`, 'utf8');
  const hash     = ethers.keccak256(preimage);
  return BigInt(hash) % BN128_PRIME;
}

/**
 * Build a complete 20-level Poseidon Merkle tree with `leaf` at index 0.
 * Returns root and the sibling path (pathElements + pathIndices) for leaf[0].
 */
async function buildTreeAndPath(poseidon, leaf, depth = 20) {
  const F    = poseidon.F;
  const zero = BigInt(0);

  // Initialise leaves: leaf at index 0, all others = 0
  let layer  = [BigInt(leaf), ...Array(Math.pow(2, depth) - 1).fill(zero)];
  const pathElements = [];
  const pathIndices  = [];

  for (let lvl = 0; lvl < depth; lvl++) {
    // The sibling of index 0 is always at index 1 (we are always on the left)
    pathIndices.push(0);
    pathElements.push(layer[1].toString());

    // Build next layer
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const h = F.toObject(poseidon([layer[i], layer[i + 1]]));
      next.push(BigInt(h));
    }
    layer = next;
  }

  const root = layer[0];
  return { root, pathElements, pathIndices };
}

async function main() {
  const args = parseArgs();

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  ZKP Role Proof Generator (with real Merkle tree)');
  console.log('═══════════════════════════════════════════════════\n');

  const roleId     = args.roleId !== undefined ? parseInt(args.roleId) : 0;
  const passphrase = args.passphrase || `test-doctor-credential-${Date.now()}`;

  // ── Derive credential from passphrase (matches browser UI logic) ──────────
  const credential = deriveCredential(passphrase, roleId);
  const salt       = BigInt('0x' + crypto.randomBytes(31).toString('hex'));

  console.log('[GEN] Role      :', ROLE_NAMES[roleId], `(id=${roleId})`);
  console.log('[GEN] Passphrase: PRIVATE (not logged)');
  console.log('[GEN] Credential: PRIVATE — derived off-chain');
  console.log('[GEN] Salt      : PRIVATE (not logged)\n');

  // ── Poseidon hash function ────────────────────────────────────────────────
  const poseidon = await buildPoseidon();
  const F        = poseidon.F;

  // ── Compute public inputs ─────────────────────────────────────────────────
  const nullifier  = F.toObject(poseidon([credential, salt]));
  const commitment = F.toObject(poseidon([credential, BigInt(roleId)]));

  console.log('[GEN] Nullifier :', nullifier.toString().slice(0, 20) + '...');
  console.log('[GEN] Commitment:', commitment.toString().slice(0, 20) + '...');

  // ── Build real Merkle tree with credential as leaf[0] ────────────────────
  // The leaf itself is the credential scalar (matching how the circuit uses it)
  console.log('\n[GEN] Building 20-level Poseidon Merkle tree...');
  const { root, pathElements, pathIndices } = await buildTreeAndPath(poseidon, credential, 20);
  const merkleRoot = root;
  console.log('[GEN] Merkle root:', merkleRoot.toString().slice(0, 20) + '...');
  console.log('[GEN] Leaf at index 0 — all path indices are 0 (left)\n');

  // ── Check compiled artefacts ──────────────────────────────────────────────
  const wasmPath = path.join(__dirname, '..', 'circuits', 'build', 'roleProof_js', 'roleProof.wasm');
  const zkeyPath = path.join(__dirname, '..', 'circuits', 'build', 'roleProof_final.zkey');

  if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
    console.error('[GEN] ERROR: Circuit artefacts not found!');
    console.error('      Run first: node scripts/setupCeremony.js');
    process.exit(1);
  }

  // ── Build circuit inputs ──────────────────────────────────────────────────
  const circuitInput = {
    credential:   credential.toString(),
    pathElements: pathElements,
    pathIndices:  pathIndices,
    salt:         salt.toString(),
    merkleRoot:   merkleRoot.toString(),
    roleId:       roleId.toString(),
    nullifier:    nullifier.toString(),
    commitment:   commitment.toString(),
  };

  // ── Generate Groth16 proof ────────────────────────────────────────────────
  console.log('[GEN] Generating Groth16 proof (this takes ~10s)...');
  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  );
  console.log(`[GEN] ✓ Proof generated in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // ── Verify proof locally (sanity check) ──────────────────────────────────
  const vkeyPath = path.join(__dirname, '..', 'circuits', 'build', 'verification_key.json');
  const vkey     = JSON.parse(fs.readFileSync(vkeyPath, 'utf8'));
  const valid    = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log('[GEN] ✓ Local proof verification:', valid ? '✅ VALID' : '❌ INVALID');

  if (!valid) { console.error('[GEN] Proof failed local verify! Aborting.'); process.exit(1); }

  // ── Export Solidity calldata ──────────────────────────────────────────────
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);

  // ── Write output (public data only — no private inputs) ──────────────────
  const output = {
    proof:            { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c, protocol: proof.protocol },
    publicSignals,
    solidityCalldata: calldata,
    role:             ROLE_NAMES[roleId],
    generatedAt:      new Date().toISOString(),
  };

  const outPath = path.join(__dirname, '..', 'proof.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log('\n[GEN] ✓ Proof saved to proof.json');
  console.log('[GEN] Public signals:');
  publicSignals.forEach((s, i) => {
    const labels = ['merkleRoot', 'roleId', 'nullifier', 'commitment'];
    console.log(`   [${i}] ${labels[i]}: ${s.toString().slice(0,20)}...`);
  });

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Calldata for on-chain submission (first 120 chars):');
  console.log('  ', calldata.slice(0, 120) + '...');
  console.log('═══════════════════════════════════════════════════\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[GEN] Error:', err.message || err);
    process.exit(1);
  });
