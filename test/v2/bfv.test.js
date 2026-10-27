const { expect } = require("chai");
const { Store } = require("../../server/store");
const { BfvService } = require("../../server/bfvService");
describe("Synthetic BFV model and persistent keys", function () {
  this.timeout(90000);
  let protocol, store, bfv;
  const key = Buffer.alloc(32, 19);
  before(async () => {
    protocol = await import("../../shared/protocol.mjs");
    store = new Store(":memory:");
    bfv = await new BfvService().init(store, key);
  });
  after(() => {
    bfv?.close();
    store?.close();
  });
  const attrs = (abo, features = [0, 0, 0, 0, 0, 0], urgency = 0) => ({
    abo,
    features,
    urgency,
  });
  it("agrees with independent plaintext policy for all ABO pairs and urgency levels", () => {
    for (const donor of ["O", "A", "B", "AB"])
      for (const recipient of ["O", "A", "B", "AB"])
        for (let urgency = 0; urgency < 3; urgency++) {
          const d = attrs(donor, [1, 0, 1, 0, 1, 0]),
            r = attrs(recipient, [0, 1, 1, 0, 0, 1], urgency);
          const got = bfv.release(
            bfv.evaluate(bfv.encryptAttributes(d), bfv.encryptAttributes(r))
          );
          // Explicit reference table and independently counted mismatch, no HE helper reuse.
          const eligible =
            donor === "O" || recipient === "AB" || donor === recipient;
          expect(got).to.deep.equal({
            eligible,
            score: eligible
              ? Math.round(700 * (1 - 4 / 6) + 150 * urgency)
              : null,
          });
        }
  });
  it("covers every mismatch boundary and demonstrates urgency changes eligible ranking", () => {
    for (let m = 0; m <= 6; m++)
      for (let u = 0; u < 3; u++) {
        const d = attrs("O"),
          r = attrs(
            "AB",
            Array.from({ length: 6 }, (_, i) => Number(i < m)),
            u
          );
        expect(
          bfv.release(
            bfv.evaluate(bfv.encryptAttributes(d), bfv.encryptAttributes(r))
          ).score
        ).to.equal(Math.round(700 * (1 - m / 6) + 150 * u));
      }
  });
  it("matches seeded randomized inputs with positive BFV noise budget", () => {
    let seed = 42;
    const rand = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed;
    };
    for (let n = 0; n < 20; n++) {
      const d = attrs(
        ["O", "A", "B", "AB"][rand() % 4],
        Array.from({ length: 6 }, () => rand() % 2)
      );
      const r = attrs(
        ["O", "A", "B", "AB"][rand() % 4],
        Array.from({ length: 6 }, () => rand() % 2),
        rand() % 3
      );
      const evaluated = bfv.evaluate(
        bfv.encryptAttributes(d),
        bfv.encryptAttributes(r)
      );
      expect(bfv.decrypt(evaluated.numerator).noise).to.be.greaterThan(0);
      expect(bfv.release(evaluated)).to.deep.equal(
        protocol.referenceScore(d, r)
      );
    }
  });
  it("loads original BFV secret after restart and fails on wrong wrapping key or missing key", async () => {
    const d = bfv.encryptAttributes(attrs("O")),
      r = bfv.encryptAttributes(attrs("A", undefined, 2));
    const reopened = await new BfvService().init(store, key);
    expect(reopened.release(reopened.evaluate(d, r))).to.deep.equal({
      eligible: true,
      score: 1000,
    });
    reopened.close();
    let failed = false;
    try {
      await new BfvService().init(store, Buffer.alloc(32, 20));
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    const broken = new Store(":memory:");
    broken.put("records", "existing", {});
    failed = false;
    try {
      await new BfvService().init(broken, key);
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    broken.close();
  });
  it("rejects malformed synthetic inputs", () => {
    for (const a of [
      attrs("Rh+"),
      attrs("O", [2, 0, 0, 0, 0, 0]),
      attrs("O", [], 0),
      attrs("O", undefined, 3),
    ])
      expect(() => protocol.validateAttributes(a)).to.throw();
  });
});
