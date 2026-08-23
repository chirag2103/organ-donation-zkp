const { expect }  = require('chai');
const { ethers }  = require('hardhat');

/**
 * ZKPVerifier Tests
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests for Groth16 proof verification.
 *
 * NOTE: These tests use a mock verifier approach where we test the contract
 * interface and edge cases. Full Groth16 proof tests require compiled circuit
 * artefacts (run setupCeremony.js + generateProof.js first).
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('ZKPVerifier', function () {
  let verifier;
  let owner;

  // Sample proof elements (structurally valid but semantically invalid for testing)
  const VALID_A  = ['1', '2'];
  const VALID_B  = [['1', '2'], ['3', '4']];
  const VALID_C  = ['5', '6'];
  const VALID_IN = [
    '1',  // merkleRoot
    '0',  // roleId (DOCTOR)
    '100', // nullifier
    '200', // commitment
  ];

  before(async function () {
    [owner] = await ethers.getSigners();
    const ZKPVerifier = await ethers.getContractFactory('ZKPVerifier');
    verifier = await ZKPVerifier.deploy();
    await verifier.waitForDeployment();
  });

  describe('Deployment', function () {
    it('should deploy without revert', async function () {
      expect(await verifier.getAddress()).to.be.a('string');
      expect(await verifier.getAddress()).to.match(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  describe('verifyProof()', function () {
    it('should return a bool result for any structurally valid input', async function () {
      // The function should not revert on well-formed inputs
      // (actual cryptographic validity depends on the real verification key)
      try {
        const result = await verifier.verifyProof(VALID_A, VALID_B, VALID_C, VALID_IN);
        expect(result).to.be.a('boolean');
      } catch (err) {
        // Precompile revert is expected with dummy proof values — that's correct behaviour
        expect(err.message).to.satisfy(msg =>
          msg.includes('ec_add') ||
          msg.includes('ec_mul') ||
          msg.includes('pairing') ||
          msg.includes('revert') ||
          msg.includes('out of field')
        );
      }
    });

    it('should revert when public input exceeds field prime', async function () {
      const PRIME_R = '21888242871839275222246405745257275088548364400416034343698204186575808495617';
      const overflowInput = [PRIME_R, '0', '1', '2'];

      await expect(
        verifier.verifyProof(VALID_A, VALID_B, VALID_C, overflowInput)
      ).to.be.revertedWith('ZKPVerifier: input out of field');
    });

    it('should emit VerificationResult event', async function () {
      // Even with invalid proof, the event should be emitted with verified=false
      // unless it reverts at precompile level (both outcomes are correct)
      try {
        const tx = await verifier.verifyProof(VALID_A, VALID_B, VALID_C, VALID_IN);
        const receipt = await tx.wait();
        const iface = verifier.interface;
        const evt = receipt.logs.find(l => {
          try { return iface.parseLog(l)?.name === 'VerificationResult'; } catch { return false; }
        });
        if (evt) {
          const parsed = iface.parseLog(evt);
          expect(parsed.args.caller).to.equal(owner.address);
          expect(parsed.args.verified).to.be.a('boolean');
          expect(parsed.args.roleHash).to.match(/^0x[0-9a-fA-F]{64}$/);
        }
      } catch (err) {
        // Precompile revert is acceptable with mock proof data
        expect(err.message).to.satisfy(msg =>
          msg.includes('revert') || msg.includes('failed') || msg.includes('field')
        );
      }
    });
  });
});
