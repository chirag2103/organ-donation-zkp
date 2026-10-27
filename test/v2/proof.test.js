const { expect } = require("chai");
const snarkjs = require("snarkjs");
const path = require("path");
const { fixture } = require("./helpers");
describe("Real v2 Groth16 circuit", function () {
  this.timeout(120000);
  let protocol, f, input, result, call;
  before(async () => {
    protocol = await import("../../shared/protocol.mjs");
    f = await fixture(true);
    const leaves = [
      protocol.hash(1234567n, 0).toString(),
      protocol.hash(7654321n, 0).toString(),
    ];
    const root = protocol.tree(leaves).root;
    await f.roles.registerCredentialRoot(0, root);
    input = protocol.proofInput({
      credential: "1234567",
      salt: "91827",
      roleId: 0,
      recipient: f.wallets[1].address,
      chainId: f.chainId,
      issuer: f.issuer.target,
      rootVersion: 1,
      leaves,
    });
    result = await snarkjs.groth16.fullProve(
      input,
      path.resolve("circuits/build/roleProof_js/roleProof.wasm"),
      path.resolve("circuits/build/roleProof_v2_final.zkey")
    );
    call = JSON.parse(
      "[" +
        (await snarkjs.groth16.exportSolidityCallData(
          result.proof,
          result.publicSignals
        )) +
        "]"
    );
  });
  it("matches Poseidon reference and supports two approved members in one root", async () => {
    const poseidon = await require("circomlibjs").buildPoseidon();
    expect(protocol.hash(12n, 34n)).to.equal(
      poseidon.F.toObject(poseidon([12n, 34n]))
    );
    const leaves = [
      protocol.hash(1234567n, 0).toString(),
      protocol.hash(7654321n, 0).toString(),
    ];
    const second = protocol.proofInput({
      credential: "7654321",
      salt: "9",
      roleId: 0,
      recipient: f.wallets[2].address,
      chainId: f.chainId,
      issuer: f.issuer.target,
      rootVersion: 1,
      leaves,
    });
    expect(second.merkleRoot).to.equal(input.merkleRoot);
    expect(second.pathIndices[0]).to.equal(1);
    const proof = await snarkjs.groth16.fullProve(
      second,
      path.resolve("circuits/build/roleProof_js/roleProof.wasm"),
      path.resolve("circuits/build/roleProof_v2_final.zkey")
    );
    const args = JSON.parse(
      "[" +
        (await snarkjs.groth16.exportSolidityCallData(
          proof.proof,
          proof.publicSignals
        )) +
        "]"
    );
    await f.issuer.connect(f.wallets[2]).verifyAndIssueKey(0, ...args);
    expect((await f.issuer.isKeyValid(f.wallets[2].address))[0]).to.equal(true);
  });
  it("verifies real proof and issues authorization to its intended recipient only", async () => {
    expect(await f.verifier.verifyProof(...call)).to.equal(true);
    await expect(
      f.issuer.connect(f.wallets[3]).verifyAndIssueKey(0, ...call)
    ).to.be.revertedWith("Recipient mismatch");
    await f.issuer.connect(f.wallets[1]).verifyAndIssueKey(0, ...call);
    expect((await f.issuer.isKeyValid(f.wallets[1].address))[0]).to.equal(true);
  });
  it("rejects alteration of every public signal, including wallet, chain, issuer and root version", async () => {
    for (let i = 0; i < 7; i++) {
      const s = [...call[3]];
      s[i] = (BigInt(s[i]) + 1n).toString();
      expect(
        await f.verifier.verifyProof(call[0], call[1], call[2], s)
      ).to.equal(false);
    }
  });
  it("rejects non-binary Merkle selectors and unregistered credentials before proving", async () => {
    const calculator =
      await require("../../circuits/build/roleProof_js/witness_calculator.js")(
        require("fs").readFileSync("circuits/build/roleProof_js/roleProof.wasm")
      );
    const bad = { ...input, pathIndices: [2, ...input.pathIndices.slice(1)] };
    let failed = false;
    try {
      await calculator.calculateWitness(bad, 1);
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    expect(() =>
      protocol.proofInput({
        credential: "9999",
        salt: "1",
        roleId: 0,
        recipient: 1,
        chainId: 1,
        issuer: 1,
        rootVersion: 1,
        leaves: ["123"],
      })
    ).to.throw("not enrolled");
  });
});
