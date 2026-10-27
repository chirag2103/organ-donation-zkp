"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  snarkjs = require("snarkjs");
const root = path.resolve(__dirname, ".."),
  build = path.join(root, "circuits", "build");
const sha = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
async function main() {
  const r1cs = path.join(build, "roleProof.r1cs"),
    ptau = path.join(build, "ptau", "pot14_prepared.ptau");
  const initial = path.join(build, "roleProof_v2_0000.zkey"),
    final = path.join(build, "roleProof_v2_final.zkey");
  if (!fs.existsSync(r1cs) || !fs.existsSync(ptau))
    throw Error("Compile circuit and supply prepared power-14 ptau first");
  const circuitHash = sha(r1cs),
    manifestFile = path.join(build, "manifest-v2.json");
  const previous = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile))
    : null;
  if (
    !previous ||
    previous.circuitHash !== circuitHash ||
    !fs.existsSync(final) ||
    previous.zkeyHash !== sha(final)
  ) {
    await snarkjs.zKey.newZKey(r1cs, ptau, initial);
    // Genuine secret phase-two entropy, never printed/persisted; local single-contributor trust model.
    await snarkjs.zKey.contribute(
      initial,
      final,
      "local-v2-contributor",
      crypto.randomBytes(64).toString("hex")
    );
  }
  const verified = await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, final);
  if (!verified) throw Error("Setup transcript verification failed");
  const vkey = await snarkjs.zKey.exportVerificationKey(final);
  fs.writeFileSync(
    path.join(build, "verification_key_v2.json"),
    JSON.stringify(vkey, null, 2)
  );
  const template = fs.readFileSync(
    path.join(root, "node_modules/snarkjs/templates/verifier_groth16.sol.ejs"),
    "utf8"
  );
  const exported = await snarkjs.zKey.exportSolidityVerifier(final, {
    groth16: template,
  });
  const solidity = exported.replace(/[ \t]+$/gm, "");
  fs.writeFileSync(path.join(root, "contracts/Groth16Verifier.sol"), solidity);
  // One generated implementation, wrapper remains intact.
  fs.writeFileSync(
    path.join(root, "contracts/ZKPVerifier_generated.sol"),
    solidity
  );
  const publicDir = path.join(root, "src/public/zkp/v2");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.copyFileSync(final, path.join(publicDir, "roleProof.zkey"));
  fs.copyFileSync(
    path.join(build, "roleProof_js/roleProof.wasm"),
    path.join(publicDir, "roleProof.wasm")
  );
  const manifest = {
    version: 2,
    circuitHash,
    zkeyHash: sha(final),
    wasmHash: sha(path.join(publicDir, "roleProof.wasm")),
    ptauHash: sha(ptau),
    verified: true,
    setup:
      "local single secret phase-two contributor; inherited local phase-one transcript",
    publicSignals: [
      "merkleRoot",
      "roleId",
      "nullifier",
      "recipient",
      "chainId",
      "issuer",
      "rootVersion",
    ],
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(publicDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  console.log("Verified v2 circuit artifacts exported:", manifest.circuitHash);
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
