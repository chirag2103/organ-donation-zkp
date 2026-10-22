const { expect }  = require('chai');
const { ethers }  = require('hardhat');
const { time }    = require('@nomicfoundation/hardhat-network-helpers');

/**
 * OrganRegistry Tests
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('OrganRegistry', function () {
  let organRegistry, pfeKeyIssuer, roleRegistry, mockVerifier;
  let owner, validUser, invalidUser, lifecycle;

  const ROLE_DOCTOR = 0;
  const MERKLE_ROOT = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  const ENC_CID   = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const HLA_ROOT  = ethers.keccak256(ethers.toUtf8Bytes('hla-root-test'));
  const BLOOD_TYPE = 0; // A+

  const DUMMY_A  = ['1', '2'];
  const DUMMY_B  = [['1', '2'], ['3', '4']];
  const DUMMY_C  = ['5', '6'];

  before(async function () {
    [owner, validUser, invalidUser, lifecycle] = await ethers.getSigners();

    // Deploy mock verifier (accepts)
    const MockVerifier = await ethers.getContractFactory('MockZKPVerifier');
    mockVerifier = await MockVerifier.deploy(true);
    await mockVerifier.waitForDeployment();

    const RoleRegistry = await ethers.getContractFactory('RoleRegistry');
    roleRegistry = await RoleRegistry.deploy();
    await roleRegistry.waitForDeployment();
    await roleRegistry.registerCredentialRoot(ROLE_DOCTOR, MERKLE_ROOT);

    const PFEKeyIssuer = await ethers.getContractFactory('PFEKeyIssuer');
    pfeKeyIssuer = await PFEKeyIssuer.deploy(
      await mockVerifier.getAddress(),
      await roleRegistry.getAddress()
    );
    await pfeKeyIssuer.waitForDeployment();

    const OrganRegistry = await ethers.getContractFactory('OrganRegistry');
    organRegistry = await OrganRegistry.deploy(await pfeKeyIssuer.getAddress());
    await organRegistry.waitForDeployment();

    // Set lifecycle manager to the `lifecycle` signer address
    await organRegistry.setLifecycleManager(lifecycle.address);

    // Issue a valid key for validUser
    await pfeKeyIssuer.connect(validUser).verifyAndIssueKey(
      ROLE_DOCTOR, DUMMY_A, DUMMY_B, DUMMY_C,
      [MERKLE_ROOT, ROLE_DOCTOR, '1000', '2000']
    );
  });

  describe('registerDonor()', function () {
    it('✓ caller with valid key can register a donor', async function () {
      const tx = await organRegistry.connect(validUser).registerDonor(
        ENC_CID, BLOOD_TYPE, HLA_ROOT
      );
      const receipt = await tx.wait();

      const iface = organRegistry.interface;
      const evt   = receipt.logs.find(l => {
        try { return iface.parseLog(l)?.name === 'DonorRegistered'; } catch { return false; }
      });

      expect(evt).to.not.be.undefined;
      const parsed = iface.parseLog(evt);
      expect(parsed.args.id).to.equal(0n);
      expect(parsed.args.encCID).to.equal(ENC_CID);
      expect(parsed.args.registeredBy).to.equal(validUser.address);
    });

    it('✓ record is stored correctly', async function () {
      const record = await organRegistry.donors(0);
      expect(record.encCID).to.equal(ENC_CID);
      expect(Number(record.bloodType)).to.equal(BLOOD_TYPE);
      expect(record.hlaRoot).to.equal(HLA_ROOT);
      expect(record.registeredBy).to.equal(validUser.address);
      expect(record.active).to.be.true;
    });

    it('✓ getEncryptedCID returns correct value', async function () {
      expect(await organRegistry.getEncryptedCID(0)).to.equal(ENC_CID);
    });

    it('✓ caller with expired key CANNOT register', async function () {
      // Advance time to expire the key
      await time.increase(4 * 3600 + 1);

      await expect(
        organRegistry.connect(validUser).registerDonor(ENC_CID, BLOOD_TYPE, HLA_ROOT)
      ).to.be.revertedWithCustomError(organRegistry, 'InvalidKey');
    });

    it('✓ caller with no key CANNOT register', async function () {
      await expect(
        organRegistry.connect(invalidUser).registerDonor(ENC_CID, BLOOD_TYPE, HLA_ROOT)
      ).to.be.revertedWithCustomError(organRegistry, 'InvalidKey');
    });

    it('✓ rejects zero encCID', async function () {
      // Need a fresh valid key — re-issue
      const MockVerifier = await ethers.getContractFactory('MockZKPVerifier');
      const mv = await MockVerifier.deploy(true);
      await mv.waitForDeployment();
      const PFE = await ethers.getContractFactory('PFEKeyIssuer');
      const pfe2 = await PFE.deploy(await mv.getAddress(), await roleRegistry.getAddress());
      const OrgReg = await ethers.getContractFactory('OrganRegistry');
      const org2 = await OrgReg.deploy(await pfe2.getAddress());
      await org2.setLifecycleManager(lifecycle.address);

      await pfe2.connect(validUser).verifyAndIssueKey(
        ROLE_DOCTOR, DUMMY_A, DUMMY_B, DUMMY_C,
        [MERKLE_ROOT, ROLE_DOCTOR, '5555', '6666']
      );

      await expect(
        org2.connect(validUser).registerDonor('', BLOOD_TYPE, HLA_ROOT)
      ).to.be.revertedWithCustomError(org2, 'ZeroEncCID');
    });
  });

  describe('deactivateDonor()', function () {
    it('✓ only LifecycleManager can call deactivateDonor', async function () {
      // Non-lifecycle caller should revert
      await expect(
        organRegistry.connect(owner).deactivateDonor(0)
      ).to.be.revertedWithCustomError(organRegistry, 'NotAuthorised');
    });

    it('✓ LifecycleManager can deactivate a donor', async function () {
      await organRegistry.connect(lifecycle).deactivateDonor(0);
      const record = await organRegistry.donors(0);
      expect(record.active).to.be.false;
    });

    it('✓ cannot deactivate an already inactive donor', async function () {
      await expect(
        organRegistry.connect(lifecycle).deactivateDonor(0)
      ).to.be.revertedWithCustomError(organRegistry, 'AlreadyInactive');
    });

    it('✓ reverts for non-existent donor', async function () {
      await expect(
        organRegistry.connect(lifecycle).deactivateDonor(9999)
      ).to.be.revertedWithCustomError(organRegistry, 'DonorNotFound');
    });
  });

  describe('getCompatibilityScore()', function () {
    let orgReg, mv, pfe, pfeKeyIssuerAddr, roleReg;

    before(async function () {
      // Need fresh instances
      const MockVerifier = await ethers.getContractFactory('MockZKPVerifier');
      mv = await MockVerifier.deploy(true);
      await mv.waitForDeployment();

      const RoleRegistry = await ethers.getContractFactory('RoleRegistry');
      roleReg = await RoleRegistry.deploy();
      await roleReg.waitForDeployment();
      await roleReg.registerCredentialRoot(ROLE_DOCTOR, MERKLE_ROOT);
      
      const PFE = await ethers.getContractFactory('PFEKeyIssuer');
      pfe = await PFE.deploy(await mv.getAddress(), await roleReg.getAddress());
      await pfe.waitForDeployment();
      pfeKeyIssuerAddr = await pfe.getAddress();

      const OrgReg = await ethers.getContractFactory('OrganRegistry');
      orgReg = await OrgReg.deploy(pfeKeyIssuerAddr);
      await orgReg.waitForDeployment();

      // Issue doctor key (has bit0 viewScore)
      await pfe.connect(validUser).verifyAndIssueKey(
        ROLE_DOCTOR, DUMMY_A, DUMMY_B, DUMMY_C,
        [MERKLE_ROOT, ROLE_DOCTOR, '888', '999']
      );

      // Register donor and recipient
      await orgReg.connect(validUser).registerDonor('donor_cid', 0, HLA_ROOT);
      await orgReg.connect(validUser).registerRecipient('recip_cid', 0, HLA_ROOT, 1);
    });

    it('✓ returns ABI-encoded data for active donor and recipient', async function () {
      const encoded = await orgReg.connect(validUser).getCompatibilityScore(0, 0);
      
      // Decode it
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['string', 'string', 'uint8', 'uint8', 'bytes32', 'bytes32', 'uint8'],
        encoded
      );

      expect(decoded[0]).to.equal('donor_cid');
      expect(decoded[1]).to.equal('recip_cid');
      expect(Number(decoded[2])).to.equal(0);
      expect(Number(decoded[3])).to.equal(0);
      expect(decoded[4]).to.equal(HLA_ROOT);
      expect(decoded[5]).to.equal(HLA_ROOT);
      expect(Number(decoded[6])).to.equal(1); // urgency
    });

    it('✓ caller without bit0 (viewScore) cannot call', async function () {
      // Issue a key for a role without bit0 (e.g. TRANSPORTER, roleId=4)
      const ROLE_TRANSPORTER = 4;
      await roleReg.registerCredentialRoot(ROLE_TRANSPORTER, MERKLE_ROOT);
      await pfe.connect(invalidUser).verifyAndIssueKey(
        ROLE_TRANSPORTER, DUMMY_A, DUMMY_B, DUMMY_C,
        [MERKLE_ROOT, ROLE_TRANSPORTER, '111', '222']
      );

      await expect(
        orgReg.connect(invalidUser).getCompatibilityScore(0, 0)
      ).to.be.revertedWithCustomError(orgReg, 'NoViewPermission');
    });

    it('✓ reverts if donor or recipient is inactive', async function () {
      // set up lifecycle and deactivate donor
      await orgReg.setLifecycleManager(lifecycle.address);
      await orgReg.connect(lifecycle).deactivateDonor(0);

      await expect(
        orgReg.connect(validUser).getCompatibilityScore(0, 0)
      ).to.be.revertedWithCustomError(orgReg, 'DonorNotFound');
    });
  });
});
