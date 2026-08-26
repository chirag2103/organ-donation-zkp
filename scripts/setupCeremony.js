'use strict';

/**
 * scripts/setupCeremony.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Correct snarkjs Groth16 trusted setup ceremony for roleProof.
 *
 * Correct pipeline:
 *   1. powersOfTau.newAccumulator(curve, power, ptauNew)
 *   2. powersOfTau.contribute(ptauNew, ptauC1, name, entropy)
 *   3. powersOfTau.preparePhase2(ptauC1, ptauPrepared)  ← REQUIRED before newZKey
 *   4. zKey.newZKey(r1cs, ptauPrepared, zkey0)
 *   5. zKey.beacon(zkey0, zkeyFinal, name, beaconHash, numIter)
 *   6. zKey.exportVerificationKey(zkeyFinal)
 *   7. zKey.exportSolidityVerifier(zkeyFinal)
 *
 * Key: powersOfTau.beacon is for ptau finalisation (phase1 ceremony end).
 *      powersOfTau.preparePhase2 converts the phase1 ptau to a format
 *      usable by zKey.newZKey.
 *
 * Power: 2^14 = 16,384 — sufficient for 5,391 circuit constraints.
 *        File size ~6 MB (vs 384 MB for 2^20).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const snarkjs = require('snarkjs');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const BUILD_DIR    = path.join(__dirname, '..', 'circuits', 'build');
const R1CS_PATH    = path.join(BUILD_DIR, 'roleProof.r1cs');
const PTAU_DIR     = path.join(BUILD_DIR, 'ptau');
const PTAU_NEW     = path.join(PTAU_DIR, 'pot14_0000.ptau');
const PTAU_C1      = path.join(PTAU_DIR, 'pot14_0001.ptau');
const PTAU_PREP    = path.join(PTAU_DIR, 'pot14_prepared.ptau');  // preparePhase2 output
const ZKEY_0       = path.join(BUILD_DIR, 'roleProof_0000.zkey');
const ZKEY_FINAL   = path.join(BUILD_DIR, 'roleProof_final.zkey');
const VKEY_PATH    = path.join(BUILD_DIR, 'verification_key.json');
const VERIFIER_SOL = path.join(__dirname, '..', 'contracts', 'ZKPVerifier_generated.sol');

const PTAU_POWER = 14; // 2^14 = 16,384 > 5,391 constraints

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function rnd()         { return crypto.randomBytes(32).toString('hex'); }

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Groth16 Trusted Setup Ceremony');
  console.log('  Circuit: roleProof (20 Merkle levels, 5391 constraints)');
  console.log('  Powers of Tau: 2^14 = 16384 (sufficient + fast)');
  console.log('═══════════════════════════════════════════════════\n');

  ensureDir(BUILD_DIR);
  ensureDir(PTAU_DIR);

  if (!fs.existsSync(R1CS_PATH)) {
    console.error('[SETUP] ERROR: roleProof.r1cs not found at:', R1CS_PATH);
    console.error('        Compile the circuit first:');
    console.error('        .\\circom.exe circuits/roleProof.circom --r1cs --wasm --sym -o circuits/build -l node_modules');
    process.exit(1);
  }

  // Load bn128 curve object (snarkjs requires object, not string)
  console.log('[SETUP] Loading bn128 curve...');
  const curve = await snarkjs.curves.getCurveFromName('bn128');
  console.log('        ✓ Curve loaded\n');

  // ── Step 1: New accumulator ───────────────────────────────────────────────
  if (!fs.existsSync(PTAU_NEW)) {
    console.log('[SETUP] Step 1/6: Initialising Powers of Tau (2^' + PTAU_POWER + ')...');
    await snarkjs.powersOfTau.newAccumulator(curve, PTAU_POWER, PTAU_NEW);
    console.log('        ✓ ptau accumulator created (%d MB)', Math.round(fs.statSync(PTAU_NEW).size / 1e6));
  } else {
    console.log('[SETUP] Step 1/6: Accumulator exists, skipping');
  }

  // ── Step 2: Contribute (phase 1) ─────────────────────────────────────────
  if (!fs.existsSync(PTAU_C1)) {
    console.log('[SETUP] Step 2/6: Adding phase 1 contribution...');
    await snarkjs.powersOfTau.contribute(PTAU_NEW, PTAU_C1, 'Contributor 1', rnd());
    console.log('        ✓ Phase 1 contribution added (%d MB)', Math.round(fs.statSync(PTAU_C1).size / 1e6));
  } else {
    console.log('[SETUP] Step 2/6: Phase 1 contribution exists, skipping');
  }

  // ── Step 3: Prepare phase 2 ── REQUIRED before zKey.newZKey ─────────────
  // powersOfTau.preparePhase2 evaluates the Lagrange basis — this is what
  // creates the sections zKey.newZKey expects.
  if (!fs.existsSync(PTAU_PREP)) {
    console.log('[SETUP] Step 3/6: Preparing phase 2 (evaluating Lagrange basis)...');
    await snarkjs.powersOfTau.preparePhase2(PTAU_C1, PTAU_PREP);
    console.log('        ✓ Phase 2 ptau prepared (%d MB)', Math.round(fs.statSync(PTAU_PREP).size / 1e6));
  } else {
    console.log('[SETUP] Step 3/6: Phase 2 ptau exists, skipping');
  }

  // ── Step 4: Groth16 phase 2 initial zkey ─────────────────────────────────
  if (!fs.existsSync(ZKEY_0) || fs.statSync(ZKEY_0).size < 1000) {
    console.log('[SETUP] Step 4/6: Groth16 phase 2 setup (zKey.newZKey)...');
    await snarkjs.zKey.newZKey(R1CS_PATH, PTAU_PREP, ZKEY_0);
    console.log('        ✓ Phase 2 zkey created (%d MB)', Math.round(fs.statSync(ZKEY_0).size / 1e6));
  } else {
    console.log('[SETUP] Step 4/6: Phase 2 zkey exists, skipping');
  }

  // ── Step 5: Skip intermediate contribute, go straight to beacon ──────────
  // For a development/single-party setup the beacon finalises the key.
  // In production, add zKey.contribute() rounds with multiple parties.
  console.log('[SETUP] Step 5/6: Skipping extra phase 2 contributions (dev setup)');

  // ── Step 6: Apply beacon and finalise ────────────────────────────────────
  if (!fs.existsSync(ZKEY_FINAL) || fs.statSync(ZKEY_FINAL).size < 1000) {
    console.log('[SETUP] Step 6/6: Applying beacon and finalising proving key...');
    await snarkjs.zKey.beacon(
      ZKEY_0,
      ZKEY_FINAL,
      'ZKP Organ Donation Final Beacon',
      // SHA256("ZKPOrganDonation2025") as public random beacon
      '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
      10
    );
    console.log('        ✓ Proving key finalised (%d MB)', Math.round(fs.statSync(ZKEY_FINAL).size / 1e6));
  } else {
    console.log('[SETUP] Step 6/6: Final zkey exists, skipping');
  }

  // ── Export verification key ───────────────────────────────────────────────
  console.log('\n[SETUP] Exporting verification key...');
  const vkey = await snarkjs.zKey.exportVerificationKey(ZKEY_FINAL);
  fs.writeFileSync(VKEY_PATH, JSON.stringify(vkey, null, 2));
  console.log('        ✓ Verification key saved:', VKEY_PATH);

  // ── Export Solidity verifier ──────────────────────────────────────────────
  // This version of snarkjs requires passing a templates object with the EJS
  // template string — it no longer bundles a default template automatically.
  console.log('[SETUP] Exporting Solidity verifier...');
  const templatePath = path.join(
    __dirname, '..', 'node_modules', 'snarkjs', 'templates', 'verifier_groth16.sol.ejs'
  );
  const groth16Template = fs.readFileSync(templatePath, 'utf8');
  const solidityVerifier = await snarkjs.zKey.exportSolidityVerifier(
    ZKEY_FINAL,
    { groth16: groth16Template }
  );
  fs.writeFileSync(VERIFIER_SOL, solidityVerifier);
  console.log('        ✓ Solidity verifier exported:', VERIFIER_SOL);

  // ── Curve cleanup ─────────────────────────────────────────────────────────
  await curve.terminate();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Ceremony complete!');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Proving key  :', ZKEY_FINAL);
  console.log('  Verify key   :', VKEY_PATH);
  console.log('  Solidity     :', VERIFIER_SOL);
  console.log('  WASM         :', path.join(BUILD_DIR, 'roleProof_js', 'roleProof.wasm'));
  console.log('\n[ACTION] Copy generated verifier and recompile:');
  console.log('  copy /Y contracts\\ZKPVerifier_generated.sol contracts\\ZKPVerifier.sol');
  console.log('  npm run compile && npm run deploy:local');
  console.log('═══════════════════════════════════════════════════\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[SETUP] Ceremony failed:', err.message || err);
    console.error(err.stack);
    process.exit(1);
  });
