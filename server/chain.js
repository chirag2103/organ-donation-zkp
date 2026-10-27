"use strict";
const fs = require("fs"),
  path = require("path");
const { ethers } = require("ethers");
class Chain {
  constructor(config) {
    this.config = config;
    const filename = path.join(
      config.root,
      "deployments",
      config.network + ".json"
    );
    if (!fs.existsSync(filename))
      throw Error("Deploy revised contracts before starting server");
    this.deployment = JSON.parse(fs.readFileSync(filename));
    if (this.deployment.protocolVersion !== 2)
      throw Error("Legacy deployment: deploy protocol v2");
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, {
      cacheTimeout: -1,
    });
    const names = {
      roles: "RoleRegistry",
      issuer: "PFEKeyIssuer",
      records: "OrganRegistry",
      lifecycle: "LifecycleManager",
    };
    for (const [key, name] of Object.entries(names)) {
      const artifact = JSON.parse(
        fs.readFileSync(
          path.join(
            config.root,
            "artifacts/contracts",
            name + ".sol",
            name + ".json"
          )
        )
      );
      this[key] = new ethers.Contract(
        this.deployment[name],
        artifact.abi,
        this.provider
      );
    }
  }
  async validate() {
    const network = await this.provider.getNetwork();
    if (Number(network.chainId) !== this.deployment.chainId)
      throw Error("Deployment chain mismatch");
    const block = await this.provider.getBlock(this.deployment.deployedBlock);
    if (!block || block.hash !== this.deployment.deployedBlockHash)
      throw Error("Stale deployment after chain reset");
    const artifact = JSON.parse(
      require("fs").readFileSync(
        require("path").join(
          this.config.root,
          "artifacts/contracts/Groth16Verifier.sol/Groth16Verifier.json"
        )
      )
    );
    if (
      ethers.keccak256(
        await this.provider.getCode(this.deployment.Groth16Verifier)
      ) !== ethers.keccak256(artifact.deployedBytecode)
    )
      throw Error(
        "Deployed verifier does not match compiled circuit artifacts"
      );
    for (const name of [
      "RoleRegistry",
      "PFEKeyIssuer",
      "OrganRegistry",
      "LifecycleManager",
    ]) {
      if ((await this.provider.getCode(this.deployment[name])) === "0x")
        throw Error("Deployment code missing");
    }
    return true;
  }
  async authorization(address) {
    const [valid, roleId, expiresAt] = await this.issuer.isKeyValid(address);
    const s = await this.issuer.sessions(address);
    return {
      valid,
      roleId: Number(roleId),
      expiresAt: Number(expiresAt),
      rootVersion: Number(s.rootVersion),
    };
  }
  async hasRecords() {
    const head = await this.provider.getBlockNumber();
    for (let from = this.deployment.deployedBlock; from <= head; from += 500) {
      const events = await this.records.queryFilter(
        this.records.filters.RecordRegistered(),
        from,
        Math.min(head, from + 499)
      );
      if (events.length) return true;
    }
    return false;
  }
  async record(id) {
    const r = await this.records.records(id);
    return {
      anchor: r.anchor,
      entityType: Number(r.entityType),
      active: r.active,
      registeredBy: r.registeredBy,
      timestamp: Number(r.timestamp),
    };
  }
  async revocationStatus(id) {
    return Number(await this.lifecycle.status(id));
  }
  async head() {
    return this.provider.getBlockNumber();
  }
  async block(n) {
    return this.provider.getBlock(n);
  }
  async events(from, to) {
    const events = [];
    for (const name of ["RevocationRequested", "RevocationExecuted"]) {
      const logs = await this.lifecycle.queryFilter(
        this.lifecycle.filters[name](),
        from,
        to
      );
      events.push(
        ...logs.map((l) => ({
          kind: name,
          id: l.args.id,
          blockNumber: l.blockNumber,
          blockHash: l.blockHash,
          index: l.index,
        }))
      );
    }
    return events.sort(
      (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
    );
  }
  async keeper() {
    // Permissionless scheduling processor uses an unlocked local test account only.
    if (this.config.network !== "localhost") return;
    if ((await this.lifecycle.scheduledCount()) === 0n) return;
    const signer = await this.provider.getSigner(9);
    await (await this.lifecycle.connect(signer).processScheduled(50)).wait();
  }
  close() {
    this.provider.destroy();
  }
}
module.exports = { Chain };
