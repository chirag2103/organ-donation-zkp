"use strict";
require("../server/config");
const hre = require("hardhat"),
  fs = require("fs"),
  path = require("path");
async function main() {
  const [owner] = await hre.ethers.getSigners();
  if (!owner) throw Error("Explicit deployer account required");
  const deployed = {};
  async function deploy(name, ...args) {
    const f = await hre.ethers.getContractFactory(
      "contracts/" + name + ".sol:" + name
    );
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    deployed[name] = await c.getAddress();
    return c;
  }
  const inner = await deploy("Groth16Verifier");
  const verifier = await deploy("ZKPVerifier", inner.target);
  const roles = await deploy("RoleRegistry");
  const issuer = await deploy("PFEKeyIssuer", verifier.target, roles.target);
  const records = await deploy("OrganRegistry", issuer.target);
  const lifecycle = await deploy(
    "LifecycleManager",
    records.target,
    issuer.target
  );
  const receipt = await (
    await records.setLifecycleManager(lifecycle.target)
  ).wait();
  const block = await hre.ethers.provider.getBlock(receipt.blockNumber),
    network = await hre.ethers.provider.getNetwork();
  const data = {
    protocolVersion: 2,
    network: hre.network.name,
    chainId: Number(network.chainId),
    ...deployed,
    deployer: owner.address,
    deployedBlock: receipt.blockNumber,
    deployedBlockHash: block.hash,
  };
  fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, "../deployments", hre.network.name + ".json"),
    JSON.stringify(data, null, 2)
  );
  fs.writeFileSync(
    path.join(__dirname, "../src/deployments.json"),
    JSON.stringify(data, null, 2)
  );
  require("./exportAbis");
  console.log("Fresh v2 deployment, no self-enrolled members:", data);
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
