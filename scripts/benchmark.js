'use strict';

/**
 * benchmark.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Run: npx hardhat run scripts/benchmark.js  (or `npm run benchmark`)
 * Output: benchmark_results.json, benchmark_results.md, benchmark_results_comparison.md
 *
 * Measures:
 *  1. ZKP proof generation time (server-side, one real Groth16 proof, ms)
 *  2. ZKP on-chain verification gas (PFEKeyIssuer.verifyAndIssueKey against
 *     the REAL Groth16Verifier — one real proof, gas is deterministic per
 *     pairing check so a single sample is representative)
 *  3. SEAL BFV encryptAttributes / computeCompatibilityScore / decryptScore
 *     time (mean ± std dev over ITERATIONS runs)
 *  4. OrganRegistry.registerDonor gas (mean/min/max over ITERATIONS runs)
 *  5. LifecycleManager.executeRevocation gas (mean/min/max over ITERATIONS runs)
 *  6. Full pipeline latency (encrypt -> register -> score -> decrypt), ms
 *
 * NOTE ON DESIGN: real Groth16 proof generation (5,391-constraint circuit,
 * 20-level Poseidon Merkle tree ~2^20 hashes) is expensive in pure-JS
 * (multiple seconds to minutes depending on the machine) — this script
 * generates exactly ONE real proof (for metrics 1-2) and uses the repo's
 * existing MockZKPVerifier for all other benchmarks, which only exercise
 * OrganRegistry/LifecycleManager/PFE and do not depend on proof validity.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const { buildPoseidon } = require('circomlibjs');
const zkpService = require('../server/zkpService');
const pfeService = require('../server/pfeService');

const ITERATIONS = 10;
const BN128_PRIME = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

function stats(times) {
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const std = Math.sqrt(
    times.reduce((s, t) => s + (t - mean) ** 2, 0) / times.length
  );
  return { mean: Number(mean.toFixed(2)), std: Number(std.toFixed(2)) };
}

async function timeIt(fn, iterations = ITERATIONS) {
  const times = [];
  let lastResult;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    lastResult = await fn();
    times.push(performance.now() - start);
  }
  return { ...stats(times), lastResult };
}

async function gasIt(txFn, iterations = ITERATIONS) {
  const gasUsed = [];
  for (let i = 0; i < iterations; i++) {
    const tx = await txFn(i);
    const receipt = await tx.wait();
    gasUsed.push(Number(receipt.gasUsed));
  }
  const mean = Math.round(gasUsed.reduce((s, g) => s + g, 0) / gasUsed.length);
  return { mean, min: Math.min(...gasUsed), max: Math.max(...gasUsed) };
}

// Cached "zero subtree hash" per level, independent of leafScalar — see
// server/zkpService.js's buildMerkleTree for the full explanation. Reduces
// this from O(2^depth) Poseidon calls (~1M at depth 20) to O(depth) (~40).
function buildMerkleTree(leafScalar, F, poseidon, depth = 20) {
  const zeroHashes = [BigInt(0)];
  for (let lvl = 1; lvl <= depth; lvl++) {
    const prev = zeroHashes[lvl - 1];
    zeroHashes.push(BigInt(F.toObject(poseidon([prev, prev]))));
  }
  const pathElements = [];
  const pathIndices = [];
  let active = leafScalar;
  for (let lvl = 0; lvl < depth; lvl++) {
    const sibling = zeroHashes[lvl];
    pathIndices.push(0);
    pathElements.push(sibling);
    active = BigInt(F.toObject(poseidon([active, sibling])));
  }
  return { root: active, pathElements, pathIndices };
}

async function main() {
  console.log('=== ZKP-PFE Organ Donation System — Benchmark Suite ===\n');
  const results = { meta: { iterations: ITERATIONS, ranAt: new Date().toISOString() } };
  const [owner, doctor, surgeon] = await ethers.getSigners();

  // ── PART A: ONE real Groth16 proof, against the REAL verifier ─────────────
  console.log('[1/6] Deploying real Groth16Verifier + ZKPVerifier + RoleRegistry + PFEKeyIssuer...');
  const Groth16Verifier = await ethers.getContractFactory(
    'contracts/Groth16Verifier.sol:Groth16Verifier'
  );
  const groth16 = await Groth16Verifier.deploy();
  await groth16.waitForDeployment();

  const ZKPVerifier = await ethers.getContractFactory('ZKPVerifier');
  const realZkpVerifier = await ZKPVerifier.deploy(await groth16.getAddress());
  await realZkpVerifier.waitForDeployment();

  const RoleRegistry = await ethers.getContractFactory('RoleRegistry');
  const realRoleRegistry = await RoleRegistry.deploy();
  await realRoleRegistry.waitForDeployment();

  const PFEKeyIssuer = await ethers.getContractFactory('PFEKeyIssuer');
  const realPfeKeyIssuer = await PFEKeyIssuer.deploy(
    await realZkpVerifier.getAddress(),
    await realRoleRegistry.getAddress()
  );
  await realPfeKeyIssuer.waitForDeployment();

  console.log('[2/6] Initialising ZKP service + generating ONE real Groth16 proof...');
  await zkpService.initZKP();
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const credential = BigInt(
    ethers.keccak256(ethers.toUtf8Bytes('zkp-credential:role0:bench-doctor'))
  ) % BN128_PRIME;
  const salt = BigInt('999001');

  const treeStart = performance.now();
  const tree = buildMerkleTree(credential, F, poseidon);
  const treeBuildMs = performance.now() - treeStart;

  await (await realRoleRegistry.registerCredentialRoot(
    0, '0x' + tree.root.toString(16).padStart(64, '0')
  )).wait();

  const proofGenStart = performance.now();
  const { proof, publicInputs } = await zkpService.generateProof({
    credential, roleId: 0, salt,
    merkleRoot: tree.root,
    pathElements: tree.pathElements,
    pathIndices: tree.pathIndices,
  });
  const proofGenMs = performance.now() - proofGenStart;
  results.zkpMerkleTreeBuildMs = { mean: Number(treeBuildMs.toFixed(2)), iterations: 1 };
  results.zkpProofGenerationMs = { mean: Number(proofGenMs.toFixed(2)), iterations: 1 };
  console.log(`   -> tree build ${treeBuildMs.toFixed(1)} ms, proof gen ${proofGenMs.toFixed(1)} ms`);

  console.log('[3/6] Measuring on-chain verification gas (real Groth16Verifier, 1 sample)...');
  const verifyTx = await realPfeKeyIssuer.connect(doctor).verifyAndIssueKey(
    0, proof.a, proof.b, proof.c, publicInputs
  );
  const verifyReceipt = await verifyTx.wait();
  results.gas_verifyAndIssueKey = {
    mean: Number(verifyReceipt.gasUsed),
    note: 'single real-proof sample; Groth16 pairing-check gas is deterministic per verification',
  };
  console.log(`   -> ${verifyReceipt.gasUsed} gas`);

  // ── PART B: everything else against a MockZKPVerifier (fast, no real proofs needed) ─
  console.log('[4/6] Deploying benchmark rig with MockZKPVerifier for non-ZKP metrics...');
  const MockZKPVerifier = await ethers.getContractFactory('MockZKPVerifier');
  const mockVerifier = await MockZKPVerifier.deploy(true);
  await mockVerifier.waitForDeployment();

  const roleRegistry = await RoleRegistry.deploy();
  await roleRegistry.waitForDeployment();
  const MOCK_ROOT_DOCTOR = '0x' + 'AA'.repeat(32);
  const MOCK_ROOT_SURGEON = '0x' + 'BB'.repeat(32);
  await (await roleRegistry.registerCredentialRoot(0, MOCK_ROOT_DOCTOR)).wait();
  await (await roleRegistry.registerCredentialRoot(5, MOCK_ROOT_SURGEON)).wait();

  const pfeKeyIssuer = await PFEKeyIssuer.deploy(
    await mockVerifier.getAddress(),
    await roleRegistry.getAddress()
  );
  await pfeKeyIssuer.waitForDeployment();

  const OrganRegistry = await ethers.getContractFactory('OrganRegistry');
  const organRegistry = await OrganRegistry.deploy(await pfeKeyIssuer.getAddress());
  await organRegistry.waitForDeployment();

  const LifecycleManager = await ethers.getContractFactory('LifecycleManager');
  const lifecycleManager = await LifecycleManager.deploy(
    await organRegistry.getAddress(), await pfeKeyIssuer.getAddress()
  );
  await lifecycleManager.waitForDeployment();
  await (await organRegistry.setLifecycleManager(await lifecycleManager.getAddress())).wait();

  // Issue mock-verified session keys for the doctor and surgeon roles used below.
  const DUMMY_A = ['1', '2'], DUMMY_B = [['1', '2'], ['3', '4']], DUMMY_C = ['5', '6'];
  await (await pfeKeyIssuer.connect(doctor).verifyAndIssueKey(
    0, DUMMY_A, DUMMY_B, DUMMY_C, [MOCK_ROOT_DOCTOR, 0, '11111', '22222']
  )).wait();
  await (await pfeKeyIssuer.connect(surgeon).verifyAndIssueKey(
    5, DUMMY_A, DUMMY_B, DUMMY_C, [MOCK_ROOT_SURGEON, 5, '33333', '44444']
  )).wait();

  console.log('[5/6] Measuring SEAL BFV encrypt/evaluate/decrypt + registerDonor/executeRevocation gas...');
  await pfeService.initPFE();

  const encryptStats = await timeIt(() => pfeService.encryptAttributes(0 /* A+ */, 0.85, 0.6));
  results.pfe_encryptAttributesMs = { mean: encryptStats.mean, std: encryptStats.std };

  const donorCts = {
    ctIsA: encryptStats.lastResult.ctIsA, ctIsB: encryptStats.lastResult.ctIsB,
    ctIsRhPos: encryptStats.lastResult.ctIsRhPos, ctHla: encryptStats.lastResult.ctHla,
  };
  const recip = pfeService.encryptAttributes(0 /* A+ */, 0.7, 0.9);
  const recipCts = { ctIsA: recip.ctIsA, ctIsB: recip.ctIsB, ctIsRhPos: recip.ctIsRhPos, ctHla: recip.ctHla };

  let lastScore;
  const evalStats = await timeIt(() => {
    lastScore = pfeService.computeCompatibilityScore(donorCts, recipCts, 100);
    return lastScore;
  });
  results.pfe_computeCompatibilityScoreMs = { mean: evalStats.mean, std: evalStats.std };

  const decryptStats = await timeIt(() => pfeService.decryptScore(lastScore));
  results.pfe_decryptScoreMs = { mean: decryptStats.mean, std: decryptStats.std };
  console.log(`   -> encrypt ${encryptStats.mean}ms, evaluate ${evalStats.mean}ms, decrypt ${decryptStats.mean}ms`);

  const gasRegisterDonor = await gasIt((i) =>
    organRegistry.connect(doctor).registerDonor(
      `bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbz${String(i).padStart(2, '0')}`,
      1,
      ethers.keccak256(ethers.toUtf8Bytes(`hla-donor-${i}`))
    )
  );
  results.gas_registerDonor = gasRegisterDonor;
  console.log(`   -> registerDonor mean ${gasRegisterDonor.mean} gas`);

  const gasRevocation = await gasIt(async (i) => {
    await (await lifecycleManager.connect(surgeon).requestRevocation(i)).wait();
    return lifecycleManager.connect(surgeon).executeRevocation(i, `ipfs://revoked-${i}`);
  });
  results.gas_executeRevocation = gasRevocation;
  console.log(`   -> executeRevocation mean ${gasRevocation.mean} gas`);

  // ── Full pipeline latency (encrypt -> register -> score -> decrypt) ───────
  console.log('[6/6] Measuring full application-layer pipeline latency (1 run)...');
  const pipelineStart = performance.now();
  {
    const donorAttrs = pfeService.encryptAttributes(0 /* A+ */, 0.9, 0.5);
    const recipAttrs = pfeService.encryptAttributes(0 /* A+ */, 0.8, 0.9);
    await (await organRegistry.connect(doctor).registerDonor(
      'bafybeigpipelinedonor', 0, ethers.keccak256(ethers.toUtf8Bytes('hla-p-d'))
    )).wait();
    const score = pfeService.computeCompatibilityScore(
      { ctIsA: donorAttrs.ctIsA, ctIsB: donorAttrs.ctIsB, ctIsRhPos: donorAttrs.ctIsRhPos, ctHla: donorAttrs.ctHla },
      { ctIsA: recipAttrs.ctIsA, ctIsB: recipAttrs.ctIsB, ctIsRhPos: recipAttrs.ctIsRhPos, ctHla: recipAttrs.ctHla },
      100
    );
    pfeService.decryptScore(score);
  }
  const pipelineMs = performance.now() - pipelineStart;
  results.pipelineLatencyMs = { mean: Number(pipelineMs.toFixed(2)), iterations: 1,
    note: 'encrypt -> registerDonor (on-chain) -> homomorphic score -> decrypt; excludes ZKP proof generation (measured separately above)' };
  console.log(`   -> ${pipelineMs.toFixed(1)} ms`);

  // ── Write outputs ───────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(__dirname, '..', 'benchmark_results.json'), JSON.stringify(results, null, 2));

  const md = `# Benchmark Results

Run at: ${results.meta.ranAt}
Iterations per metric: ${ITERATIONS} (except one-shot ZKP proof generation/verification and full-pipeline latency — see notes)

| Metric | Mean | Std Dev / Range | Unit |
|--------|------|------------------|------|
| ZKP Merkle tree build (20 levels, 1 leaf) | ${results.zkpMerkleTreeBuildMs.mean} | 1 sample | ms |
| ZKP proof generation (server, Groth16/BN128) | ${results.zkpProofGenerationMs.mean} | 1 sample | ms |
| PFEKeyIssuer.verifyAndIssueKey (real Groth16Verifier, incl. pairing check) | ${results.gas_verifyAndIssueKey.mean} | 1 sample | gas |
| SEAL BFV encryptAttributes (3 attrs) | ${results.pfe_encryptAttributesMs.mean} | ${results.pfe_encryptAttributesMs.std} | ms |
| SEAL BFV computeCompatibilityScore (homomorphic) | ${results.pfe_computeCompatibilityScoreMs.mean} | ${results.pfe_computeCompatibilityScoreMs.std} | ms |
| SEAL BFV decryptScore | ${results.pfe_decryptScoreMs.mean} | ${results.pfe_decryptScoreMs.std} | ms |
| OrganRegistry.registerDonor | ${results.gas_registerDonor.mean} | min ${results.gas_registerDonor.min} / max ${results.gas_registerDonor.max} | gas |
| LifecycleManager.executeRevocation (incl. requestRevocation) | ${results.gas_executeRevocation.mean} | min ${results.gas_executeRevocation.min} / max ${results.gas_executeRevocation.max} | gas |
| Application-layer pipeline (encrypt → register → score → decrypt) | ${results.pipelineLatencyMs.mean} | 1 sample | ms |

> **Note on ZKP metrics:** proof generation and on-chain verification gas are
> reported from a single real proof against the actual \`Groth16Verifier\`
> contract (not the test mock) rather than a mean over many runs — the
> 20-level Poseidon Merkle tree (~2^20 hashes) makes repeated real proof
> generation prohibitively slow in pure JS on commodity hardware, and the
> Groth16 pairing-check gas cost is deterministic per verification regardless
> of the specific proof/public inputs, so one sample is representative.
> All other metrics (PFE timings, \`registerDonor\`/\`executeRevocation\` gas)
> are averaged over ${ITERATIONS} runs and do not depend on ZKP proof validity —
> they are measured against a \`MockZKPVerifier\`-backed \`PFEKeyIssuer\` deployment.
`;
  fs.writeFileSync(path.join(__dirname, '..', 'benchmark_results.md'), md);

  const comparison = `# Comparison with Prior Work

| Feature                          | This Work | Samsukha et al. [5] | Block-Privacy [BP] |
|-----------------------------------|-----------|----------------------|----------------------|
| ZKP role authentication          | ✅ Yes    | ❌ No                | ✅ Yes (generic)      |
| PFE polynomial scoring           | ✅ Yes    | ✅ Yes               | ❌ No (general FE)    |
| IPFS off-chain ciphertext store  | ✅ Yes    | ❌ Referenced only   | ✅ Yes                |
| Organ-specific workflow          | ✅ Yes    | ✅ Yes               | ❌ General IoMT       |
| GDPR Art. 17 revocation          | ✅ Yes    | ❌ No                | ❌ No                 |
| ZKP gates PFE key issuance       | ✅ Yes    | ❌ No                | ❌ No                 |
| Clinical matching variables      | 3 vars    | 3 vars               | N/A                   |
| Replay attack protection         | ✅ Yes    | ❌ Not specified     | ❌ Not specified      |
| On-chain ZKP verification (gas)  | ${results.gas_verifyAndIssueKey.mean} | N/A | Not reported |
| Proof generation time            | ${results.zkpProofGenerationMs.mean} ms | Not reported | Not reported |
| Post-quantum resistance          | ❌ Future | ❌ No                | ❌ No                 |
`;
  fs.writeFileSync(path.join(__dirname, '..', 'benchmark_results_comparison.md'), comparison);

  console.log('\nSaved: benchmark_results.json, benchmark_results.md, benchmark_results_comparison.md');
  console.log('\n' + JSON.stringify(results, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
