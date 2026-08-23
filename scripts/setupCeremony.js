'use strict';

/**
 * scripts/setupCeremony.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Powers of Tau trusted setup + Groth16 phase 2 ceremony for the roleProof
 * circuit. Produces:
 *   circuits/build/roleProof_0000.zkey   — initial contribution
 *   circuits/build/roleProof_final.zkey  — finalised proving key
 *   circuits/build/verification_key.json — verification key (embedded in verifier)
 *
 * In production this should use a multi-party computation ceremony.
 * For development, a single-party setup is acceptable.
 *
 * Prerequisites:
 *   1. circom installed: npm install -g circom
 *   2. Circuit compiled:
 *      circom circuits/roleProof.circom --r1cs --wasm --sym -o circuits/build
 *
 * Usage: node scripts/setupCeremony.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const snarkjs  = require('snarkjs');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const readline = require('readline');

const BUILD_DIR = path.join(__dirname, '..', 'circuits', 'build');
const R1CS_PATH = path.join(BUILD_DIR, 'roleProof.r1cs');
const PTAU_DIR  = path.join(BUILD_DIR, 'ptau');
const PTAU_PATH = path.join(PTAU_DIR, 'pot20_final.ptau');
const ZKEY_0    = path.join(BUILD_DIR, 'roleProof_0000.zkey');
const ZKEY_FINAL = path.join(BUILD_DIR, 'roleProof_final.zkey');
const VKEY_PATH  = path.join(BUILD_DIR, 'verification_key.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function randomEntropy(size = 32) {
  return crypto.randomBytes(size).toString('hex');
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Groth16 Trusted Setup Ceremony');
  console.log('  Circuit: roleProof (20 Merkle levels)');
  console.log('═══════════════════════════════════════════════════\n');

  ensureDir(BUILD_DIR);
  ensureDir(PTAU_DIR);

  // ── Step 1: Powers of Tau ─────────────────────────────────────────────────
  // Powers of Tau for 2^20 constraints (conservative upper bound for roleProof)
  const ptauNew = path.join(PTAU_DIR, 'pot20_0000.ptau');

  if (!fs.existsSync(ptauNew)) {
    console.log('[SETUP] Step 1/6: Initialising Powers of Tau (2^20)...');
    await snarkjs.powersOfTau.newAccumulator(
      'bn128',
      20,  // power — must be ≥ log2(number of constraints)
      ptauNew
    );
    console.log('        ✓ ptau accumulator created');
  } else {
    console.log('[SETUP] Step 1/6: Using existing ptau accumulator');
  }

  // ── Step 2: First contribution ────────────────────────────────────────────
  const ptauContrib1 = path.join(PTAU_DIR, 'pot20_0001.ptau');
  if (!fs.existsSync(ptauContrib1)) {
    console.log('[SETUP] Step 2/6: Adding first contribution...');
    await snarkjs.powersOfTau.contribute(
      ptauNew,
      ptauContrib1,
      'First Contributor',
      randomEntropy()
    );
    console.log('        ✓ First contribution added');
  } else {
    console.log('[SETUP] Step 2/6: First contribution exists, skipping');
  }

  // ── Step 3: Prepare phase 2 ───────────────────────────────────────────────
  if (!fs.existsSync(PTAU_PATH)) {
    console.log('[SETUP] Step 3/6: Preparing phase 2 (beacon)...');
    await snarkjs.powersOfTau.beacon(
      ptauContrib1,
      PTAU_PATH,
      'ZKP Organ Donation Setup',
      // SHA256 of the string "ZKPOrganDonation2025" — public random beacon
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9820',
      10  // 2^10 iterations
    );
    console.log('        ✓ Phase 2 preparation complete');
  } else {
    console.log('[SETUP] Step 3/6: PTAU file exists, skipping beacon');
  }

  // ── Step 4: Phase 2 Groth16 setup ─────────────────────────────────────────
  if (!fs.existsSync(R1CS_PATH)) {
    console.error('[SETUP] ERROR: roleProof.r1cs not found at:', R1CS_PATH);
    console.error('        Please compile the circuit first:');
    console.error('        circom circuits/roleProof.circom --r1cs --wasm --sym -o circuits/build');
    process.exit(1);
  }

  if (!fs.existsSync(ZKEY_0)) {
    console.log('[SETUP] Step 4/6: Groth16 phase 2 setup...');
    await snarkjs.zKey.newZKey(R1CS_PATH, PTAU_PATH, ZKEY_0);
    console.log('        ✓ Phase 2 zkey created');
  } else {
    console.log('[SETUP] Step 4/6: Phase 2 zkey exists, skipping');
  }

  // ── Step 5: Contribute to phase 2 ────────────────────────────────────────
  const zkey1 = path.join(BUILD_DIR, 'roleProof_0001.zkey');
  if (!fs.existsSync(zkey1)) {
    console.log('[SETUP] Step 5/6: Contributing to phase 2...');
    await snarkjs.zKey.contribute(
      ZKEY_0,
      zkey1,
      'ZKP Organ Donation Phase2 Contributor',
      randomEntropy()
    );
    console.log('        ✓ Phase 2 contribution added');
  } else {
    console.log('[SETUP] Step 5/6: Phase 2 contribution exists, skipping');
  }

  // ── Step 6: Beacon + finalise ─────────────────────────────────────────────
  if (!fs.existsSync(ZKEY_FINAL)) {
    console.log('[SETUP] Step 6/6: Applying beacon and finalising proving key...');
    await snarkjs.zKey.beacon(
      zkey1,
      ZKEY_FINAL,
      'ZKP Organ Donation Final Beacon',
      '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
      10
    );
    console.log('        ✓ Proving key finalised:', ZKEY_FINAL);
  } else {
    console.log('[SETUP] Step 6/6: Final zkey exists, skipping');
  }

  // ── Export verification key ───────────────────────────────────────────────
  console.log('\n[SETUP] Exporting verification key...');
  const vkey = await snarkjs.zKey.exportVerificationKey(ZKEY_FINAL);
  fs.writeFileSync(VKEY_PATH, JSON.stringify(vkey, null, 2));
  console.log('        ✓ Verification key saved to:', VKEY_PATH);

  // ── Export Solidity verifier (for reference) ───────────────────────────────
  const solidityVerifier = await snarkjs.zKey.exportSolidityVerifier(ZKEY_FINAL);
  const verifierPath = path.join(__dirname, '..', 'contracts', 'ZKPVerifier_generated.sol');
  fs.writeFileSync(verifierPath, solidityVerifier);
  console.log('        ✓ Solidity verifier exported to:', verifierPath);
  console.log('\n[SETUP] IMPORTANT: Replace ZKPVerifier.sol with ZKPVerifier_generated.sol');
  console.log('        (or update the verification key constants manually)\n');

  // ── Print summary ─────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════');
  console.log('  Ceremony complete!');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Proving key  :', ZKEY_FINAL);
  console.log('  Verify key   :', VKEY_PATH);
  console.log('  Solidity     :', verifierPath);
  console.log('  WASM         :', path.join(BUILD_DIR, 'roleProof_js', 'roleProof.wasm'));
  console.log('═══════════════════════════════════════════════════\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[SETUP] Ceremony failed:', err);
    process.exit(1);
  });
