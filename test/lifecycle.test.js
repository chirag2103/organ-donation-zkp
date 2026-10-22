const { expect }   = require('chai');
const { ethers }   = require('hardhat');
const { time }     = require('@nomicfoundation/hardhat-network-helpers');

/**
 * LifecycleManager Tests
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');

describe('LifecycleManager', function () {
  let lifecycle, organRegistry, pfeKeyIssuer, roleRegistry, mockVerifier;
  let owner, surgeon, coordinator, noPermUser;

  // SURGEON (roleId=5) has bit5 (triggerRevocation)
  const ROLE_SURGEON      = 5;
  const ROLE_MATCHING     = 3;  // no bit5 permission
  const MERKLE_ROOT_SURG  = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const MERKLE_ROOT_MATCH = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

  const ENC_CID  = 'bafytest';
  const HLA_ROOT = ethers.keccak256(ethers.toUtf8Bytes('hla'));
  const DUMMY_A  = ['1', '2'];
  const DUMMY_B  = [['1', '2'], ['3', '4']];
  const DUMMY_C  = ['5', '6'];

  let donorId = 0;

  before(async function () {
    [owner, surgeon, coordinator, noPermUser] = await ethers.getSigners();

    // Deploy contracts
    const MockVerifier = await ethers.getContractFactory('MockZKPVerifier');
    mockVerifier = await MockVerifier.deploy(true);

    const RoleRegistry = await ethers.getContractFactory('RoleRegistry');
    roleRegistry = await RoleRegistry.deploy();
    await roleRegistry.registerCredentialRoot(ROLE_SURGEON, MERKLE_ROOT_SURG);
    await roleRegistry.registerCredentialRoot(ROLE_MATCHING, MERKLE_ROOT_MATCH);

    const PFEKeyIssuer = await ethers.getContractFactory('PFEKeyIssuer');
    pfeKeyIssuer = await PFEKeyIssuer.deploy(
      await mockVerifier.getAddress(),
      await roleRegistry.getAddress()
    );

    const OrganRegistry = await ethers.getContractFactory('OrganRegistry');
    organRegistry = await OrganRegistry.deploy(await pfeKeyIssuer.getAddress());

    const LifecycleManager = await ethers.getContractFactory('LifecycleManager');
    lifecycle = await LifecycleManager.deploy(
      await organRegistry.getAddress(),
      await pfeKeyIssuer.getAddress()
    );

    await organRegistry.setLifecycleManager(await lifecycle.getAddress());

    // Issue SURGEON key (has bit5)
    await pfeKeyIssuer.connect(surgeon).verifyAndIssueKey(
      ROLE_SURGEON, DUMMY_A, DUMMY_B, DUMMY_C,
      [MERKLE_ROOT_SURG, ROLE_SURGEON, '11111', '22222']
    );

    // Issue MATCHING key (no bit5)
    await pfeKeyIssuer.connect(noPermUser).verifyAndIssueKey(
      ROLE_MATCHING, DUMMY_A, DUMMY_B, DUMMY_C,
      [MERKLE_ROOT_MATCH, ROLE_MATCHING, '33333', '44444']
    );

    // Register a donor using surgeon's key (surgeon has bit2: updateOrganStatus but NOT bit5 for donor registration)
    // We need a role with valid key — coordinator role has bits 0–4
    // Use surgeon as registeredBy (they have a valid key regardless of bits)
    const tx = await organRegistry.connect(surgeon).registerDonor(ENC_CID, 0, HLA_ROOT);
    const receipt = await tx.wait();
    const iface   = organRegistry.interface;
    const evt     = receipt.logs.find(l => {
      try { return iface.parseLog(l)?.name === 'DonorRegistered'; } catch { return false; }
    });
    donorId = evt ? Number(iface.parseLog(evt).args.id) : 0;
  });

  describe('requestRevocation()', function () {
    it('✓ emits RevocationRequested when called with bit5 permission', async function () {
      await expect(lifecycle.connect(surgeon).requestRevocation(donorId))
        .to.emit(lifecycle, 'RevocationRequested')
        .withArgs(donorId, surgeon.address, anyValue);
    });

    it('✓ caller without bit5 permission reverts', async function () {
      await expect(
        lifecycle.connect(noPermUser).requestRevocation(donorId)
      ).to.be.revertedWithCustomError(lifecycle, 'NoRevocationPermission');
    });
  });

  describe('executeRevocation()', function () {
    it('✓ emits RevocationExecuted with correct CID', async function () {
      await expect(lifecycle.connect(surgeon).executeRevocation(donorId, ENC_CID))
        .to.emit(lifecycle, 'RevocationExecuted')
        .withArgs(donorId, ENC_CID, anyValue);
    });

    it('✓ donor record is deactivated after executeRevocation', async function () {
      const record = await organRegistry.donors(donorId);
      expect(record.active).to.be.false;
    });

    it('✓ double revocation of same donorId reverts', async function () {
      // Revocation status is already Executed
      await expect(
        lifecycle.connect(surgeon).executeRevocation(donorId, ENC_CID)
      ).to.be.revertedWithCustomError(lifecycle, 'AlreadyRevoked');
    });

    it('✓ execute without prior request reverts', async function () {
      const newDonorId = 999; // doesn't exist
      await expect(
        lifecycle.connect(surgeon).executeRevocation(newDonorId, ENC_CID)
      ).to.be.revertedWithCustomError(lifecycle, 'RevocationNotRequested');
    });
  });

  describe('scheduleAutoRevocation()', function () {
    it('✓ owner can schedule auto revocation', async function () {
      // Register a second donor
      const tx2  = await organRegistry.connect(surgeon).registerDonor(
        'cid2', 1, HLA_ROOT
      );
      const rec2 = await tx2.wait();
      const iface = organRegistry.interface;
      const evt2  = rec2.logs.find(l => {
        try { return iface.parseLog(l)?.name === 'DonorRegistered'; } catch { return false; }
      });
      const newId = evt2 ? Number(iface.parseLog(evt2).args.id) : 1;

      await expect(lifecycle.scheduleAutoRevocation(newId, 30))
        .to.emit(lifecycle, 'AutoRevocationScheduled');

      expect(await lifecycle.scheduledCount()).to.be.greaterThan(0);
    });

    it('✓ processScheduled() executes expired schedule', async function () {
      // Advance time by 30 days + 1 second
      await time.increase(30 * 24 * 3600 + 1);
      await expect(lifecycle.processScheduled()).to.not.be.reverted;
    });
  });
});
