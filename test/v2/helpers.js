const { ethers } = require("hardhat");
async function fixture(real = false) {
  const wallets = await ethers.getSigners();
  const deploy = async (name, ...args) => {
    const f = await ethers.getContractFactory(
      "contracts/" + name + ".sol:" + name
    );
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const roles = await deploy("RoleRegistry");
  const inner = real ? await deploy("Groth16Verifier") : null;
  const verifier = real
    ? await deploy("ZKPVerifier", inner.target)
    : await deploy("MockZKPVerifier", true);
  const issuer = await deploy("PFEKeyIssuer", verifier.target, roles.target);
  const records = await deploy("OrganRegistry", issuer.target);
  const lifecycle = await deploy(
    "LifecycleManager",
    records.target,
    issuer.target
  );
  await (await records.setLifecycleManager(lifecycle.target)).wait();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  let nullifier = 1n;
  async function authorize(wallet, role) {
    if ((await roles.roots(role)) === 0n)
      await (
        await roles.registerCredentialRoot(role, 123n + BigInt(role))
      ).wait();
    const s = [
      await roles.roots(role),
      role,
      nullifier++,
      BigInt(wallet.address),
      chainId,
      BigInt(issuer.target),
      await roles.versions(role),
    ];
    const proof = [
      [1, 2],
      [
        [1, 2],
        [3, 4],
      ],
      [5, 6],
    ];
    await (
      await issuer.connect(wallet).verifyAndIssueKey(role, ...proof, s)
    ).wait();
    return { s, proof };
  }
  return {
    wallets,
    roles,
    verifier,
    issuer,
    records,
    lifecycle,
    chainId,
    authorize,
  };
}
module.exports = { fixture };
