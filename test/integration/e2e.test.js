const { expect } = require('chai');
const { ethers } = require('hardhat');
const zkpService = require('../../server/zkpService');
const pfeService = require('../../server/pfeService');
const snarkjs = require('snarkjs');

describe('End-to-End System Integration', function () {
  this.timeout(300000); // 5 minutes for ZKP generation and PFE ops

  let owner, doctorWallet, surgeonWallet;
  let roleRegistry, zkpVerifier, pfeKeyIssuer, organRegistry, lifecycleManager;
  let doctorRoot, surgeonRoot;
  let doctorNullifier, surgeonNullifier;

  before(async function () {
    [owner, doctorWallet, surgeonWallet] = await ethers.getSigners();
    
    // 1. Deploy Contracts
    const RoleRegistry = await ethers.getContractFactory('RoleRegistry');
    roleRegistry = await RoleRegistry.deploy();

    const ZKPVerifier = await ethers.getContractFactory('ZKPVerifier');
    zkpVerifier = await ZKPVerifier.deploy(ethers.ZeroAddress);

    const PFEKeyIssuer = await ethers.getContractFactory('PFEKeyIssuer');
    pfeKeyIssuer = await PFEKeyIssuer.deploy(zkpVerifier.target, roleRegistry.target);

    const OrganRegistry = await ethers.getContractFactory('OrganRegistry');
    organRegistry = await OrganRegistry.deploy(pfeKeyIssuer.target);

    const LifecycleManager = await ethers.getContractFactory('LifecycleManager');
    lifecycleManager = await LifecycleManager.deploy(organRegistry.target, pfeKeyIssuer.target);

    await organRegistry.setLifecycleManager(lifecycleManager.target);

    // Initialize services
    await pfeService.initPFE();

    // 2. Compute Merkle Roots and Register
    await zkpService.initZKP();
    const poseidon = await require('circomlibjs').buildPoseidon();
    const F = poseidon.F;
    const BN128_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

    const generateMockZkpParams = (roleId, passphrase) => {
      const preimage = Buffer.from(`zkp-credential:role${roleId}:${passphrase}`, 'utf8');
      const hash = ethers.keccak256(preimage);
      const credential = BigInt(hash) % BN128_PRIME;
      const salt = BigInt('12345');
      
      // Only leaf 0 (credential) is non-zero, so every sibling on its path
      // is an all-zero subtree's hash - precompute those once (O(depth)
      // Poseidon calls) instead of hashing all 2^depth leaves (O(2^depth),
      // ~1M calls at depth 20) for the identical root.
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
      return { credential, salt, root: active, pathElements, pathIndices };
    };

    // For Doctor (Role 0):
    const docParams = generateMockZkpParams(0, 'doctor-pass');
    doctorRoot = '0x' + docParams.root.toString(16).padStart(64, '0');
    await roleRegistry.connect(owner).registerCredentialRoot(0, doctorRoot);
    
    this.doctorProof = await zkpService.generateProof({
      credential: docParams.credential,
      roleId: 0,
      salt: docParams.salt,
      merkleRoot: docParams.root,
      pathElements: docParams.pathElements,
      pathIndices: docParams.pathIndices
    });

    // For Surgeon (Role 5):
    const surgParams = generateMockZkpParams(5, 'surgeon-pass');
    surgeonRoot = '0x' + surgParams.root.toString(16).padStart(64, '0');
    await roleRegistry.connect(owner).registerCredentialRoot(5, surgeonRoot);

    this.surgeonProof = await zkpService.generateProof({
      credential: surgParams.credential,
      roleId: 5,
      salt: surgParams.salt,
      merkleRoot: surgParams.root,
      pathElements: surgParams.pathElements,
      pathIndices: surgParams.pathIndices
    });
  });

  it('Step 1: Doctor proves role via ZKP and obtains PFE session key', async function () {
    const pubSignals = this.doctorProof.publicInputs;
    const p = this.doctorProof.proof;

    const keyCommitment = ethers.keccak256(ethers.toUtf8Bytes("doc-session-key"));
    
    // Format for contract
    const a = p.a;
    const b = p.b;
    const c = p.c;

    await expect(pfeKeyIssuer.connect(doctorWallet).verifyAndIssueKey(0, a, b, c, pubSignals))
      .to.emit(pfeKeyIssuer, 'KeyIssued');
    const [isValid, role] = await pfeKeyIssuer.isKeyValid(doctorWallet.address);
    expect(isValid).to.be.true;
    expect(role).to.equal(0);
  });

  it('Step 2: Surgeon proves role via ZKP and obtains PFE session key', async function () {
    const pubSignals = this.surgeonProof.publicInputs;
    const p = this.surgeonProof.proof;

    const a = p.a;
    const b = p.b;
    const c = p.c;

    await expect(pfeKeyIssuer.connect(surgeonWallet).verifyAndIssueKey(5, a, b, c, pubSignals))
      .to.emit(pfeKeyIssuer, 'KeyIssued');
    const [isValid, role] = await pfeKeyIssuer.isKeyValid(surgeonWallet.address);
    expect(isValid).to.be.true;
    expect(role).to.equal(5);
  });

  it('Step 3: Doctor encrypts donor & recipient attributes using PFE', async function () {
    // Donor: Blood=1, HLA=0.9, Urgency=0.5
    const donorPfe = pfeService.encryptAttributes(1, 0.9, 0.5);
    // Recipient: Blood=1, HLA=0.8, Urgency=0.9
    const recipPfe = pfeService.encryptAttributes(1, 0.8, 0.9);

    // Mock IPFS CIDs that would normally point to a JSON containing these ciphertexts
    this.donorEncCID = "ipfs://QmDonorDataMock" + Date.now();
    this.recipEncCID = "ipfs://QmRecipDataMock" + Date.now();

    // Store attributes in test context for step 5
    this.donorPfe = donorPfe;
    this.recipPfe = recipPfe;

    expect(donorPfe.ctHla).to.be.a('string');
    expect(recipPfe.ctHla).to.be.a('string');
  });

  it('Step 4: Doctor registers Donor and Recipient on-chain', async function () {
    // Register Donor
    await expect(organRegistry.connect(doctorWallet).registerDonor(
      this.donorEncCID,
      1, // bloodType
      ethers.keccak256(ethers.toUtf8Bytes("hla1"))
    )).to.emit(organRegistry, 'DonorRegistered');

    // Register Recipient
    await expect(organRegistry.connect(doctorWallet).registerRecipient(
      this.recipEncCID,
      1, // bloodType
      ethers.keccak256(ethers.toUtf8Bytes("hla2")),
      2 // urgency (high)
    )).to.emit(organRegistry, 'RecipientRegistered');
  });

  it('Step 5: System calculates compatibility score homomorphically', async function () {
    // In a real flow, backend queries contract for getCompatibilityScore, gets CIDs, downloads ciphertexts from IPFS, evaluates, and returns to UI.
    
    // We bypass IPFS fetch here and just use the ciphertexts we have
    const donorCts = { ctIsA: this.donorPfe.ctIsA, ctIsB: this.donorPfe.ctIsB, ctIsRhPos: this.donorPfe.ctIsRhPos, ctHla: this.donorPfe.ctHla };
    const recipCts = { ctIsA: this.recipPfe.ctIsA, ctIsB: this.recipPfe.ctIsB, ctIsRhPos: this.recipPfe.ctIsRhPos, ctHla: this.recipPfe.ctHla };

    const encryptedScore = pfeService.computeCompatibilityScore(donorCts, recipCts, 100);
    const decryptedScore = pfeService.decryptScore(encryptedScore);

    // Both donor and recipient are blood type index 1 (A-) -> identical
    // blood type -> real ABO/Rh compatibility check finds 0 incompatibility.
    // HLA 0.9 vs 0.8 -> a small nonzero contribution from HLA_WEIGHT.
    expect(decryptedScore).to.equal(3);
  });

  it('Step 6: Surgeon triggers lifecycle revocation', async function () {
    // Surgeon has bit 5 (triggerRevocation)
    // Donor ID is 0 (first registered)
    await expect(lifecycleManager.connect(surgeonWallet).requestRevocation(0))
      .to.emit(lifecycleManager, 'RevocationRequested')
      .withArgs(0, surgeonWallet.address, (ts) => ts > 0);

    await expect(lifecycleManager.connect(surgeonWallet).executeRevocation(0, "ipfs://mock-cid"))
      .to.emit(lifecycleManager, 'RevocationExecuted')
      .withArgs(0, "ipfs://mock-cid", (ts) => ts > 0);

    // Check donor is inactive
    const donor = await organRegistry.donors(0);
    expect(donor.active).to.be.false;
  });
});
