const { expect }   = require('chai');
const { ethers }   = require('hardhat');
const { time }     = require('@nomicfoundation/hardhat-network-helpers');

/**
 * PFEKeyIssuer Tests
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses a MockZKPVerifier that accepts or rejects proofs based on a flag.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Deploy a mock ZKP verifier for testing ────────────────────────────────
async function deployMockVerifier(shouldVerify = true) {
  const MockVerifier = await ethers.getContractFactory('MockZKPVerifier');
  const mock = await MockVerifier.deploy(shouldVerify);
  await mock.waitForDeployment();
  return mock;
}

describe('PFEKeyIssuer', function () {
  let pfeKeyIssuer;
  let roleRegistry;
  let mockVerifier;
  let owner, user1, user2;

  const ROLE_DOCTOR  = 0;
  const ROLE_SURGEON = 5;

  const DUMMY_A  = ['1', '2'];
  const DUMMY_B  = [['1', '2'], ['3', '4']];
  const DUMMY_C  = ['5', '6'];

  const MERKLE_ROOT = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const NULLIFIER   = '777';
  const COMMITMENT  = '888';

  const DUMMY_INPUTS = [
    MERKLE_ROOT,  // pubInputs[0] = merkleRoot
    ROLE_DOCTOR,  // pubInputs[1] = roleId
    NULLIFIER,    // pubInputs[2] = nullifier
    COMMITMENT,   // pubInputs[3] = commitment
  ];

  before(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy mock verifier that ACCEPTS proofs
    mockVerifier = await deployMockVerifier(true);

    const RoleRegistry = await ethers.getContractFactory('RoleRegistry');
    roleRegistry = await RoleRegistry.deploy();
    await roleRegistry.waitForDeployment();

    // Register merkle root for DOCTOR role
    await roleRegistry.registerCredentialRoot(ROLE_DOCTOR, MERKLE_ROOT);

    const PFEKeyIssuer = await ethers.getContractFactory('PFEKeyIssuer');
    pfeKeyIssuer = await PFEKeyIssuer.deploy(
      await mockVerifier.getAddress(),
      await roleRegistry.getAddress()
    );
    await pfeKeyIssuer.waitForDeployment();
  });

  describe('Deployment', function () {
    it('should set correct zkpVerifier and roleRegistry addresses', async function () {
      expect(await pfeKeyIssuer.zkpVerifier()).to.equal(await mockVerifier.getAddress());
      expect(await pfeKeyIssuer.roleRegistry()).to.equal(await roleRegistry.getAddress());
    });

    it('should have KEY_TTL = 4 hours', async function () {
      expect(await pfeKeyIssuer.KEY_TTL()).to.equal(4 * 3600);
    });
  });

  describe('verifyAndIssueKey()', function () {
    it('✓ issues key after valid ZKP proof', async function () {
      const tx = await pfeKeyIssuer.connect(user1).verifyAndIssueKey(
        ROLE_DOCTOR, DUMMY_A, DUMMY_B, DUMMY_C, DUMMY_INPUTS
      );
      const receipt = await tx.wait();

      const iface   = pfeKeyIssuer.interface;
      const evt     = receipt.logs.find(l => {
        try { return iface.parseLog(l)?.name === 'KeyIssued'; } catch { return false; }
      });

      expect(evt).to.not.be.undefined;
      const parsed = iface.parseLog(evt);
      expect(parsed.args.recipient).to.equal(user1.address);
      expect(Number(parsed.args.roleId)).to.equal(ROLE_DOCTOR);
      expect(parsed.args.keyCommitment).to.match(/^0x[0-9a-fA-F]{64}$/);
      expect(Number(parsed.args.expiresAt)).to.be.greaterThan(0);
    });

    it('✓ isKeyValid returns true immediately after issuance', async function () {
      const [valid, roleId, expiresAt] = await pfeKeyIssuer.isKeyValid(user1.address);
      expect(valid).to.be.true;
      expect(Number(roleId)).to.equal(ROLE_DOCTOR);
      expect(Number(expiresAt)).to.be.greaterThan(Math.floor(Date.now() / 1000));
    });

    it('✓ reverts with ZKPVerificationFailed on invalid proof', async function () {
      // Deploy mock that REJECTS proofs
      const rejectingVerifier = await deployMockVerifier(false);
      const RoleRegistry = await ethers.getContractFactory('RoleRegistry');
      const reg2 = await RoleRegistry.deploy();
      await reg2.waitForDeployment();
      await reg2.registerCredentialRoot(ROLE_DOCTOR, MERKLE_ROOT);

      const PFEKeyIssuer = await ethers.getContractFactory('PFEKeyIssuer');
      const issuer2 = await PFEKeyIssuer.deploy(
        await rejectingVerifier.getAddress(),
        await reg2.getAddress()
      );

      await expect(
        issuer2.connect(user2).verifyAndIssueKey(
          ROLE_DOCTOR,
          DUMMY_A, DUMMY_B, DUMMY_C,
          [MERKLE_ROOT, ROLE_DOCTOR, '999', '1000'] // fresh nullifier
        )
      ).to.be.revertedWithCustomError(issuer2, 'ZKPVerificationFailed');
    });

    it('✓ isKeyValid returns false after TTL expires', async function () {
      // Check isKeyValid is true now
      let [valid] = await pfeKeyIssuer.isKeyValid(user1.address);
      expect(valid).to.be.true;

      // Advance time by 4 hours + 1 second
      await time.increase(4 * 3600 + 1);

      [valid] = await pfeKeyIssuer.isKeyValid(user1.address);
      expect(valid).to.be.false;
    });

    it('✓ same nullifier cannot be reused (replay protection)', async function () {
      // The nullifier NULLIFIER = '777' was used by user1 above
      // user2 tries to reuse it — should revert
      await expect(
        pfeKeyIssuer.connect(user2).verifyAndIssueKey(
          ROLE_DOCTOR, DUMMY_A, DUMMY_B, DUMMY_C, DUMMY_INPUTS
        )
      ).to.be.revertedWithCustomError(pfeKeyIssuer, 'NullifierAlreadyUsed');
    });
  });

  describe('hasPermission()', function () {
    it('returns false for expired key', async function () {
      // user1's key is expired (from the TTL test above)
      const hasPerm = await pfeKeyIssuer.hasPermission(user1.address, 0);
      expect(hasPerm).to.be.false;
    });
  });
});
