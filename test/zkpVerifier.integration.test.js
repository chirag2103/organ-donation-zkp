const { expect } = require('chai');
const { ethers } = require('hardhat');
const snarkjs    = require('snarkjs');
const path       = require('path');
const crypto     = require('crypto');
const { buildPoseidon } = require('circomlibjs');

const BN128_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

describe('ZKPVerifier Integration (Real Groth16 Proof)', function () {
  this.timeout(300000); // Proof generation can take up to 2-3 minutes in JS

  let groth16Verifier, zkpVerifier;
  let proofA, proofB, proofC, publicSignals;
  let caller;

  before(async function () {
    [caller] = await ethers.getSigners();

    // 1. Deploy the real Groth16Verifier (snarkjs generated)
    const Groth16Verifier = await ethers.getContractFactory('contracts/Groth16Verifier.sol:Groth16Verifier');
    groth16Verifier = await Groth16Verifier.deploy();
    await groth16Verifier.waitForDeployment();

    // 2. Deploy the wrapper ZKPVerifier
    const ZKPVerifier = await ethers.getContractFactory('ZKPVerifier');
    zkpVerifier = await ZKPVerifier.deploy(await groth16Verifier.getAddress());
    await zkpVerifier.waitForDeployment();

    // 3. Generate a real Groth16 proof inline
    const roleId = 0;
    const passphrase = 'test-credential';
    
    // Derive credential
    const preimage = Buffer.from(`zkp-credential:role${roleId}:${passphrase}`, 'utf8');
    const hash     = ethers.keccak256(preimage);
    const credential = BigInt(hash) % BN128_PRIME;
    const salt       = BigInt('12345'); // Static salt for test

    const poseidon = await buildPoseidon();
    const F        = poseidon.F;

    const nullifier  = F.toObject(poseidon([credential, salt]));
    const commitment = F.toObject(poseidon([credential, BigInt(roleId)]));

    // Build tree. Only leaf 0 (credential) is non-zero, so every sibling on
    // its path is an all-zero subtree's hash - a value that depends only on
    // level, not on the credential. Precompute those once (O(depth) Poseidon
    // calls) instead of naively hashing all 2^depth leaves (O(2^depth) calls,
    // ~1M at depth 20 - minutes instead of milliseconds for the same root).
    const depth = 20;
    const zeroHashes = [BigInt(0)];
    for (let lvl = 1; lvl <= depth; lvl++) {
      const prev = zeroHashes[lvl - 1];
      zeroHashes.push(BigInt(F.toObject(poseidon([prev, prev]))));
    }
    const pathElements = [];
    const pathIndices  = [];
    let active = credential;

    for (let lvl = 0; lvl < depth; lvl++) {
      const sibling = zeroHashes[lvl];
      pathIndices.push(0);
      pathElements.push(sibling.toString());
      active = BigInt(F.toObject(poseidon([active, sibling])));
    }
    const merkleRoot = active;

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

    const wasmPath = path.join(__dirname, '..', 'circuits', 'build', 'roleProof_js', 'roleProof.wasm');
    const zkeyPath = path.join(__dirname, '..', 'circuits', 'build', 'roleProof_final.zkey');

    console.log(circuitInput);
    const { proof, publicSignals: pubSigs } = await snarkjs.groth16.fullProve(
      circuitInput,
      wasmPath,
      zkeyPath
    );

    // Parse proof into format expected by Solidity
    proofA = [proof.pi_a[0], proof.pi_a[1]];
    proofB = [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]]
    ];
    proofC = [proof.pi_c[0], proof.pi_c[1]];
    publicSignals = pubSigs;
  });

  it('✓ should verify a valid Groth16 proof on-chain and emit event', async function () {
    const tx = await zkpVerifier.verifyProof(proofA, proofB, proofC, publicSignals);
    const receipt = await tx.wait();

    // The function doesn't return the bool directly because it's a state-changing tx
    // But it emits a VerificationResult event
    const iface = zkpVerifier.interface;
    const evt = receipt.logs.find(l => {
      try { return iface.parseLog(l)?.name === 'VerificationResult'; } catch { return false; }
    });

    expect(evt).to.not.be.undefined;
    const parsed = iface.parseLog(evt);
    expect(parsed.args.verified).to.be.true;
    expect(parsed.args.caller).to.equal(caller.address);
  });

  it('✓ tampered proof should return false (not revert) and emit verified = false', async function () {
    // Flip a bit in proofA
    const tamperedA = [...proofA];
    tamperedA[0] = (BigInt(proofA[0]) + 1n).toString();

    const tx = await zkpVerifier.verifyProof(tamperedA, proofB, proofC, publicSignals);
    const receipt = await tx.wait();

    const iface = zkpVerifier.interface;
    const evt = receipt.logs.find(l => {
      try { return iface.parseLog(l)?.name === 'VerificationResult'; } catch { return false; }
    });

    expect(evt).to.not.be.undefined;
    const parsed = iface.parseLog(evt);
    expect(parsed.args.verified).to.be.false;
  });
});
