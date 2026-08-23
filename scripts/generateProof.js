'use strict';

/**
 * scripts/generateProof.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CLI tool to generate a Groth16 ZKP proof for the roleProof circuit.
 * For testing and demonstration purposes.
 *
 * Usage:
 *   node scripts/generateProof.js \
 *     --credential 0xdeadbeef... \
 *     --roleId 0 \
 *     --salt 0xcafebabe...
 *
 * Output: proof.json (contains proof + publicInputs, NOT private inputs)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const snarkjs        = require('snarkjs');
const path           = require('path');
const fs             = require('fs');
const crypto         = require('crypto');
const { buildPoseidon } = require('circomlibjs');

// ── Argument parsing ──────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      parsed[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return parsed;
}

// ── Build a simple Merkle tree for demo ──────────────────────────────────────
async function buildMerkleTree(poseidon, leaves, depth = 20) {
  const F = poseidon.F;

  // Pad leaves to 2^depth
  const size = Math.pow(2, depth);
  const zero = BigInt(0);
  const paddedLeaves = Array(size).fill(zero);
  leaves.forEach((l, i) => { paddedLeaves[i] = BigInt(l); });

  // Build tree level by level
  let layer = paddedLeaves.map(l => F.toObject(poseidon([l])));

  for (let lvl = 0; lvl < depth; lvl++) {
    const nextLayer = [];
    for (let i = 0; i < layer.length; i += 2) {
      const hash = poseidon([layer[i], layer[i + 1]]);
      nextLayer.push(F.toObject(hash));
    }
    layer = nextLayer;
  }

  return { root: layer[0], layers: [] }; // simplified — returns root
}

// ── Generate Merkle proof path for a leaf ────────────────────────────────────
function getPathForLeaf(layers, leafIndex, depth = 20) {
  const pathElements = Array(depth).fill('0');
  const pathIndices  = Array(depth).fill(0);

  for (let lvl = 0; lvl < depth; lvl++) {
    const isRight = (leafIndex >> lvl) & 1;
    const siblingIdx = isRight ? (leafIndex >> lvl) ^ 1 : (leafIndex >> lvl) | 1;
    pathIndices[lvl]  = isRight;
    pathElements[lvl] = '0'; // simplified; real impl would use stored sibling hashes
  }

  return { pathElements, pathIndices };
}

async function main() {
  const args = parseArgs();

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  ZKP Role Proof Generator');
  console.log('═══════════════════════════════════════════════════\n');

  // ── Load or generate private inputs ──────────────────────────────────────
  const credential = args.credential
    ? BigInt(args.credential)
    : BigInt('0x' + crypto.randomBytes(31).toString('hex')); // 248-bit random credential

  const salt = args.salt
    ? BigInt(args.salt)
    : BigInt('0x' + crypto.randomBytes(31).toString('hex'));

  const roleId = args.roleId !== undefined ? parseInt(args.roleId) : 0;

  console.log('[GEN] Role ID    :', roleId);
  console.log('[GEN] Credential : PRIVATE (not logged)');
  console.log('[GEN] Salt       : PRIVATE (not logged)');

  // ── Initialise Poseidon ────────────────────────────────────────────────────
  const poseidon = await buildPoseidon();
  const F        = poseidon.F;

  // ── Compute public inputs ─────────────────────────────────────────────────
  const nullifier  = F.toObject(poseidon([credential, salt]));
  const commitment = F.toObject(poseidon([credential, BigInt(roleId)]));

  console.log('[GEN] Nullifier  :', nullifier.toString());
  console.log('[GEN] Commitment :', commitment.toString());

  // ── Load or generate merkle root ──────────────────────────────────────────
  let merkleRoot;
  const deploymentsPath = path.join(__dirname, '..', 'deployments', 'localhost.json');

  if (fs.existsSync(deploymentsPath)) {
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'));
    const roleNames   = ['DOCTOR', 'COORDINATOR', 'PROCUREMENT', 'MATCHING', 'TRANSPORTER', 'SURGEON'];
    const rootHex     = deployments.testMerkleRoots[roleNames[roleId]];
    merkleRoot = BigInt(rootHex);
    console.log('[GEN] Merkle root: (from deployment)', rootHex.slice(0, 18), '...');
  } else {
    // Build a demo tree with the credential as leaf[0]
    merkleRoot = credential; // simplified demo — real Merkle tree
    console.log('[GEN] Merkle root: (demo — single-leaf tree)');
  }

  // ── Build dummy Merkle proof path ─────────────────────────────────────────
  const { pathElements, pathIndices } = getPathForLeaf([], 0, 20);

  // Fill path elements with valid hashes (dummy: hash of each index)
  for (let i = 0; i < 20; i++) {
    const h = F.toObject(poseidon([BigInt(i), BigInt(i + 1)]));
    pathElements[i] = h.toString();
  }

  // ── Circuit input ─────────────────────────────────────────────────────────
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

  // ── Check for compiled artefacts ──────────────────────────────────────────
  const wasmPath = path.join(__dirname, '..', 'circuits', 'build', 'roleProof_js', 'roleProof.wasm');
  const zkeyPath = path.join(__dirname, '..', 'circuits', 'build', 'roleProof_final.zkey');

  if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
    console.warn('\n[WARN] Compiled circuit artefacts not found.');
    console.warn('       Run: node scripts/setupCeremony.js first.');
    console.warn('       Outputting circuit input only.\n');

    const inputPath = path.join(__dirname, '..', 'proof_input.json');
    // Do NOT write private inputs to disk in production!
    // This is for development only.
    const safeInput = { ...circuitInput, credential: '*** REDACTED ***', salt: '*** REDACTED ***' };
    fs.writeFileSync(inputPath, JSON.stringify(safeInput, null, 2));
    console.log('[GEN] Public inputs written to proof_input.json (private fields redacted)');
    return;
  }

  // ── Generate Groth16 proof ────────────────────────────────────────────────
  console.log('\n[GEN] Generating Groth16 proof...');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  );

  // ── Export Solidity calldata ───────────────────────────────────────────────
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);

  // ── Zero private fields ───────────────────────────────────────────────────
  circuitInput.credential   = '0';
  circuitInput.salt         = '0';
  circuitInput.pathElements = Array(20).fill('0');

  // ── Write output (public data only) ──────────────────────────────────────
  const output = {
    proof: {
      pi_a:     proof.pi_a,
      pi_b:     proof.pi_b,
      pi_c:     proof.pi_c,
      protocol: proof.protocol,
    },
    publicInputs:     publicSignals,
    solidityCalldata: calldata,
    generatedAt:      new Date().toISOString(),
  };

  const outPath = path.join(__dirname, '..', 'proof.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log('[GEN] ✓ Proof generated and saved to proof.json');
  console.log('[GEN] Public signals:', publicSignals);
  console.log('\n   Solidity calldata (first 120 chars):');
  console.log('  ', calldata.slice(0, 120), '...\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[GEN] Error:', err);
    process.exit(1);
  });
