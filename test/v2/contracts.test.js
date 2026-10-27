const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { fixture } = require("./helpers");
describe("Protocol v2 contract authorization and lifecycle", function () {
  let f;
  beforeEach(async () => {
    f = await fixture();
  });
  it("enforces the complete role matrix for donor and recipient registration", async () => {
    for (let role = 0; role < 6; role++) {
      const wallet = f.wallets[role + 1];
      await f.authorize(wallet, role);
      for (let type = 0; type < 2; type++) {
        const id = ethers.id("record" + role + type),
          tx = f.records
            .connect(wallet)
            .registerRecord(id, ethers.id("ciphertext"), type);
        const allowed =
          type === 0 ? [0, 1, 2].includes(role) : [0, 1].includes(role);
        if (allowed) await expect(tx).to.emit(f.records, "RecordRegistered");
        else await expect(tx).to.be.revertedWith("Registration forbidden");
      }
    }
  });
  it("rejects unapproved roles, wrong wallet/domain/version, replay and expired/revoked sessions", async () => {
    const wallet = f.wallets[1],
      { s, proof } = await f.authorize(wallet, 0);
    await expect(
      f.issuer.connect(wallet).verifyAndIssueKey(0, ...proof, s)
    ).to.be.revertedWith("Nullifier used");
    await expect(
      f.issuer.connect(f.wallets[2]).verifyAndIssueKey(0, ...proof, s)
    ).to.be.revertedWith("Recipient mismatch");
    for (const index of [4, 5]) {
      const copy = [...s];
      copy[index] = 1;
      await expect(
        f.issuer.connect(wallet).verifyAndIssueKey(0, ...proof, copy)
      ).to.be.revertedWith("Domain mismatch");
    }
    const wrongVersion = [...s];
    wrongVersion[6] = 99;
    await expect(
      f.issuer.connect(wallet).verifyAndIssueKey(0, ...proof, wrongVersion)
    ).to.be.revertedWith("Version mismatch");
    await f.issuer.revokeSession(wallet.address);
    expect((await f.issuer.isKeyValid(wallet.address))[0]).to.equal(false);
    await f.authorize(wallet, 0);
    await time.increase(14401);
    expect((await f.issuer.isKeyValid(wallet.address))[0]).to.equal(false);
  });
  it("invalidates existing sessions on root update and restricts enrollment to owner", async () => {
    await f.authorize(f.wallets[1], 0);
    await f.roles.registerCredentialRoot(0, 999);
    expect((await f.issuer.isKeyValid(f.wallets[1].address))[0]).to.equal(
      false
    );
    await expect(f.roles.connect(f.wallets[1]).registerCredentialRoot(0, 1000))
      .to.be.reverted;
  });
  it("supports canonical-ID revocation of both types, without a caller-selected CID", async () => {
    await f.authorize(f.wallets[1], 0);
    await f.authorize(f.wallets[2], 5);
    for (let type = 0; type < 2; type++) {
      const id = ethers.id("entity" + type);
      await f.records
        .connect(f.wallets[1])
        .registerRecord(id, ethers.id("cipher"), type);
      await expect(
        f.lifecycle.connect(f.wallets[1]).requestRevocation(id)
      ).to.be.revertedWith("Revocation forbidden");
      await f.lifecycle.connect(f.wallets[2]).requestRevocation(id);
      await expect(f.lifecycle.connect(f.wallets[2]).executeRevocation(id))
        .to.emit(f.lifecycle, "RevocationExecuted")
        .withArgs(id);
      expect(await f.records.isActive(id)).to.equal(false);
      await expect(
        f.lifecycle.connect(f.wallets[2]).executeRevocation(id)
      ).to.be.revertedWith("Not requested");
    }
  });
  it("bounds inspected scheduled entries, revisits future entries and prevents duplicate deactivation", async () => {
    await f.authorize(f.wallets[1], 0);
    const id = ethers.id("scheduled");
    await f.records
      .connect(f.wallets[1])
      .registerRecord(id, ethers.id("cipher"), 0);
    const now = await time.latest();
    await f.lifecycle.scheduleAutoRevocation(id, now + 100);
    await f.lifecycle.processScheduled(1);
    expect(await f.records.isActive(id)).to.equal(true);
    await time.increase(101);
    await f.lifecycle.processScheduled(1);
    expect(await f.records.isActive(id)).to.equal(false);
    await f.lifecycle.processScheduled(1);
    await expect(f.lifecycle.processScheduled(51)).to.be.revertedWith(
      "Limit 1..50"
    );
  });
  it("contains no clinical attributes or CID in registration ABI/storage shape", () => {
    const names = f.records.interface
      .getFunction("registerRecord")
      .inputs.map((i) => i.name);
    expect(names).to.deep.equal(["id", "anchor", "entityType"]);
    expect(
      f.records.interface.getFunction("records").outputs.map((x) => x.name)
    ).to.deep.equal([
      "anchor",
      "entityType",
      "active",
      "registeredBy",
      "timestamp",
    ]);
  });
});
