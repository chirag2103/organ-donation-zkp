import * as snarkjs from "snarkjs";
import { proofInput } from "../shared/protocol.mjs";
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (x) =>
    x.toString(16).padStart(2, "0")
  ).join("");
self.onmessage = async ({ data }) => {
  try {
    const { credential, membership, address, deployment, manifest } = data;
    const input = proofInput({
      credential: credential.secret,
      roleId: credential.roleId,
      salt: BigInt("0x" + hex(crypto.getRandomValues(new Uint8Array(31)))) + "",
      recipient: address,
      chainId: deployment.chainId,
      issuer: deployment.PFEKeyIssuer,
      rootVersion: membership.rootVersion,
      leaves: membership.leaves,
    });
    if (input.merkleRoot !== membership.root)
      throw Error("Membership path/root mismatch");
    const load = async (name, expected) => {
      const response = await fetch("/zkp/v2/" + name);
      if (!response.ok)
        throw Error("Proof artifacts missing; run npm run ceremony");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== expected)
        throw Error("Proof artifact hash mismatch");
      return bytes;
    };
    const [wasm, zkey] = await Promise.all([
      load("roleProof.wasm", manifest.wasmHash),
      load("roleProof.zkey", manifest.zkeyHash),
    ]);
    const result = await snarkjs.groth16.fullProve(input, wasm, zkey);
    const call = JSON.parse(
      "[" +
        (await snarkjs.groth16.exportSolidityCallData(
          result.proof,
          result.publicSignals
        )) +
        "]"
    );
    self.postMessage({ a: call[0], b: call[1], c: call[2], signals: call[3] });
  } catch (e) {
    self.postMessage({ error: e.message || "Browser proof generation failed" });
  }
};
