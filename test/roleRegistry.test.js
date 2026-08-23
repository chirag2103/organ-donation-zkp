const { expect }  = require('chai');
const { ethers }  = require('hardhat');

/**
 * RoleRegistry Tests
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('RoleRegistry', function () {
  let registry;
  let owner, nonOwner;

  const MERKLE_ROOTS = [
    '0x1111111111111111111111111111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222222222222222222222222222',
    '0x3333333333333333333333333333333333333333333333333333333333333333',
    '0x4444444444444444444444444444444444444444444444444444444444444444',
    '0x5555555555555555555555555555555555555555555555555555555555555555',
    '0x6666666666666666666666666666666666666666666666666666666666666666',
  ];

  // Expected permission bitmasks for each role (matching constructor values)
  const EXPECTED_PERMISSIONS = [
    0x17, // DOCTOR:      bits 0,1,2,4 = viewScore + viewIdentity + updateStatus + confirmTransplant
    0x1F, // COORDINATOR: bits 0–4 = all except triggerRevocation
    0x0D, // PROCUREMENT: bits 0,2,3 = viewScore + updateStatus + initiateTransport
    0x03, // MATCHING:    bits 0,1   = viewScore + viewIdentity
    0x08, // TRANSPORTER: bit3       = initiateTransport
    0x33, // SURGEON:     bits 0,1,4,5 = viewScore + viewIdentity + confirmTransplant + triggerRevocation
  ];

  before(async function () {
    [owner, nonOwner] = await ethers.getSigners();
    const RoleRegistry = await ethers.getContractFactory('RoleRegistry');
    registry = await RoleRegistry.deploy();
    await registry.waitForDeployment();
  });

  describe('Deployment', function () {
    it('should set the correct owner', async function () {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it('should have ROLE_COUNT = 6', async function () {
      expect(await registry.ROLE_COUNT()).to.equal(6);
    });
  });

  describe('Permission bitmasks', function () {
    for (let roleId = 0; roleId < 6; roleId++) {
      it(`should return correct permission mask for role ${roleId}`, async function () {
        const perm = await registry.getPermissions(roleId);
        expect(Number(perm)).to.equal(EXPECTED_PERMISSIONS[roleId]);
      });
    }

    it('should revert for invalid roleId', async function () {
      await expect(registry.getPermissions(6))
        .to.be.revertedWithCustomError(registry, 'InvalidRoleId');
      await expect(registry.getPermissions(255))
        .to.be.revertedWithCustomError(registry, 'InvalidRoleId');
    });
  });

  describe('hasPermission()', function () {
    it('DOCTOR should have viewCompatibilityScore (bit0)', async function () {
      expect(await registry.hasPermission(0, 0)).to.be.true;
    });

    it('TRANSPORTER should NOT have confirmTransplant (bit4)', async function () {
      expect(await registry.hasPermission(4, 4)).to.be.false;
    });

    it('SURGEON should have triggerRevocation (bit5)', async function () {
      expect(await registry.hasPermission(5, 5)).to.be.true;
    });

    it('MATCHING should NOT have triggerRevocation (bit5)', async function () {
      expect(await registry.hasPermission(3, 5)).to.be.false;
    });
  });

  describe('registerCredentialRoot()', function () {
    it('owner can register credential root for each role', async function () {
      for (let roleId = 0; roleId < 6; roleId++) {
        const tx = await registry.registerCredentialRoot(roleId, MERKLE_ROOTS[roleId]);
        await expect(tx)
          .to.emit(registry, 'CredentialRootUpdated')
          .withArgs(roleId, MERKLE_ROOTS[roleId]);
      }
    });

    it('should return the registered root via getRoleRoot()', async function () {
      for (let roleId = 0; roleId < 6; roleId++) {
        const root = await registry.getRoleRoot(roleId);
        expect(root).to.equal(MERKLE_ROOTS[roleId]);
      }
    });

    it('non-owner CANNOT register credential root', async function () {
      await expect(
        registry.connect(nonOwner).registerCredentialRoot(
          0,
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        )
      ).to.be.revertedWithCustomError(registry, 'OwnableUnauthorizedAccount');
    });

    it('should revert on zero merkle root', async function () {
      await expect(
        registry.registerCredentialRoot(0, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, 'ZeroMerkleRoot');
    });

    it('should revert for invalid roleId', async function () {
      await expect(
        registry.registerCredentialRoot(
          6,
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        )
      ).to.be.revertedWithCustomError(registry, 'InvalidRoleId');
    });
  });

  describe('getRoleName()', function () {
    const names = ['DOCTOR', 'COORDINATOR', 'PROCUREMENT', 'MATCHING', 'TRANSPORTER', 'SURGEON'];
    for (let i = 0; i < 6; i++) {
      it(`role ${i} should have name ${names[i]}`, async function () {
        expect(await registry.getRoleName(i)).to.equal(names[i]);
      });
    }
  });
});
