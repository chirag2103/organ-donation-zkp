const { expect } = require('chai');
const pfeService = require('../server/pfeService');

describe('PFE Service Integration', function () {
  this.timeout(10000);

  before(async function () {
    await pfeService.initPFE();
  });

  function scoreOf(donorBloodType, donorHla, recipBloodType, recipHla, W = 100) {
    const donor = pfeService.encryptAttributes(donorBloodType, donorHla, 0.5);
    const recip = pfeService.encryptAttributes(recipBloodType, recipHla, 0.5);
    const donorCts = { ctIsA: donor.ctIsA, ctIsB: donor.ctIsB, ctIsRhPos: donor.ctIsRhPos, ctHla: donor.ctHla };
    const recipCts = { ctIsA: recip.ctIsA, ctIsB: recip.ctIsB, ctIsRhPos: recip.ctIsRhPos, ctHla: recip.ctHla };
    const encryptedScore = pfeService.computeCompatibilityScore(donorCts, recipCts, W);
    return pfeService.decryptScore(encryptedScore);
  }

  // Blood type indices (see BLOOD_DECOMPOSE in pfeService.js):
  // 0=A+ 1=A- 2=B+ 3=B- 4=AB+ 5=AB- 6=O+ 7=O-

  it('✓ should encrypt donor and recipient attributes, compute score homomorphically, and decrypt', async function () {
    // B+ donor -> A+ recipient is real-world INCOMPATIBLE (donor's B antigen
    // has no counterpart in the recipient), contributing W=100. HLA differs
    // 0.8 vs 0.4 -> weighted contribution 48 (see file header formula).
    const donorAttrs = pfeService.encryptAttributes(2 /* B+ */, 0.8, 0.5);
    const recipAttrs = pfeService.encryptAttributes(0 /* A+ */, 0.4, 0.9);

    const donorCts = { ctIsA: donorAttrs.ctIsA, ctIsB: donorAttrs.ctIsB, ctIsRhPos: donorAttrs.ctIsRhPos, ctHla: donorAttrs.ctHla };
    const recipCts = { ctIsA: recipAttrs.ctIsA, ctIsB: recipAttrs.ctIsB, ctIsRhPos: recipAttrs.ctIsRhPos, ctHla: recipAttrs.ctHla };

    const W = 100;
    const encryptedScore = pfeService.computeCompatibilityScore(donorCts, recipCts, W);

    expect(typeof encryptedScore).to.equal('string');

    const decryptedScore = pfeService.decryptScore(encryptedScore);

    // Raw dissimilarity distance (0 = perfect match); real ABO/Rh
    // incompatibility (B antigen mismatch, 100) + weighted HLA diff (48).
    expect(decryptedScore).to.equal(148);
  });

  it('✓ should return 0 for a perfect match (identical blood type and HLA)', async function () {
    expect(scoreOf(0 /* A+ */, 0.9, 0 /* A+ */, 0.9)).to.equal(0);
  });

  it('✓ should return 0 when blood is really compatible even if categories differ (O- universal donor)', async function () {
    // O- is the universal donor - compatible with every recipient blood
    // type, including AB+ (the universal recipient). Old crude "same bit"
    // scheme would have flagged this as a mismatch; the real ABO/Rh check
    // correctly finds no incompatibility.
    expect(scoreOf(7 /* O- */, 0.9, 4 /* AB+ */, 0.9)).to.equal(0);
  });

  it('✓ should heavily penalise a maximally incompatible blood pairing (AB+ donor -> O- recipient)', async function () {
    // AB+ can only donate to AB+; giving to O- is incompatible on all three
    // antigens (A, B, and Rh) -> 3 * W = 300.
    expect(scoreOf(4 /* AB+ */, 0.5, 7 /* O- */, 0.5)).to.equal(300);
  });

  it('✓ two different-but-compatible blood types no longer collapse to a false "perfect" score', async function () {
    // Regression test for the bug where any two non-A+ blood types (e.g.
    // B+ donor, O- recipient) were indistinguishable to the old crude
    // binary encoding, producing a wrongly "perfect" score even with a
    // large HLA gap. B+ -> O- is really incompatible (B+ can't give to O-).
    const score = scoreOf(2 /* B+ */, 0.02, 7 /* O- */, 0.70);
    expect(score).to.be.greaterThan(0);
  });
});
