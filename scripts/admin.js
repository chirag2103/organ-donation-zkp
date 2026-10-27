"use strict";
const path = require("path");
const { ethers } = require("ethers");
const { config } = require("../server/config");
const { Chain } = require("../server/chain");
const { Store } = require("../server/store");
async function main() {
  const cfg = config(),
    chain = new Chain(cfg);
  await chain.validate();
  const store = new Store(
    path.join(
      cfg.dataDir,
      chain.deployment.deployedBlockHash.slice(2, 18),
      "service.sqlite"
    )
  );
  const [command, arg1, arg2] = process.argv.slice(2),
    protocol = await import("../shared/protocol.mjs");
  try {
    if (command === "retry") {
      const job = store.get("revocations", arg1);
      if (!job) throw Error("Unknown cleanup job");
      store.put("revocations", arg1, {
        ...job,
        state: "cleanup pending",
        nextAttempt: 0,
      });
      console.log("Cleanup queued");
      return;
    }
    // Administrator keys are supplied to this CLI only, never placed in the service .env.
    const signer = process.env.ADMIN_PRIVATE_KEY
      ? new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, chain.provider)
      : ["localhost", "e2e"].includes(cfg.network)
      ? await chain.provider.getSigner(0)
      : null;
    if (!signer)
      throw Error("ADMIN_PRIVATE_KEY required outside local development");
    const roles = chain.roles.connect(signer),
      lifecycle = chain.lifecycle.connect(signer);
    if (
      command === "enroll" ||
      command === "remove" ||
      command === "reconcile"
    ) {
      const roleId = Number(arg1);
      if (!Number.isInteger(roleId) || roleId < 0 || roleId > 5)
        throw Error("Role must be 0..5");
      const current = store.get("memberships", String(roleId)) || {
        leaves: [],
      };
      let leaves = [...current.leaves];
      if (command !== "reconcile") {
        const leaf = BigInt(arg2);
        if (leaf <= 0n || leaf >= protocol.FIELD)
          throw Error("Leaf outside field");
        if (command === "enroll") {
          if (leaves.includes(leaf.toString())) throw Error("Already enrolled");
          leaves.push(leaf.toString());
        } else {
          if (!leaves.includes(leaf.toString())) throw Error("Not enrolled");
          leaves = leaves.filter((x) => x !== leaf.toString());
        }
      }
      const root = protocol.tree(leaves).root;
      // Persist intent before publication; API refuses inconsistent root until reconcile succeeds.
      store.put("memberships", String(roleId), { leaves, root });
      if ((await roles.roots(roleId)).toString() !== root)
        await (await roles.registerCredentialRoot(roleId, root)).wait();
      console.log(
        "Membership root published; previous role sessions require reauthentication."
      );
    } else if (command === "schedule") {
      if (
        !/^0x[a-f0-9]{64}$/i.test(arg1) ||
        !Number.isSafeInteger(Number(arg2))
      )
        throw Error("schedule <recordId> <unixSeconds>");
      await (await lifecycle.scheduleAutoRevocation(arg1, Number(arg2))).wait();
      console.log("Retention scheduled");
    } else if (command === "revoke-session") {
      await (await chain.issuer.connect(signer).revokeSession(arg1)).wait();
      console.log("Session revoked");
    } else
      throw Error(
        "Usage: admin.js enroll|remove <role> <leaf>; reconcile <role>; schedule <id> <unixSeconds>; retry <id>; revoke-session <wallet>"
      );
  } finally {
    store.close();
    chain.close();
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
