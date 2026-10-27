const assert = require("node:assert/strict");

describe("Wallet network selection", function () {
  let selectWalletChain, checkWalletChain;
  const deployment = { chainId: 31337, network: "localhost" };
  before(async () => {
    ({ selectWalletChain, checkWalletChain } = await import(
      "../../src/wallet.mjs"
    ));
  });
  function wallet({
    chain = "0x1",
    unknown = false,
    error,
    switchWorks = true,
  } = {}) {
    const calls = [];
    return {
      calls,
      async request(request) {
        calls.push(request);
        if (request.method === "eth_chainId") return chain;
        if (request.method === "wallet_switchEthereumChain") {
          if (error) throw error;
          if (unknown)
            throw Object.assign(Error("Unknown chain"), { code: 4902 });
          if (switchWorks) chain = request.params[0].chainId;
          return null;
        }
        if (request.method === "wallet_addEthereumChain") {
          unknown = false;
          return null;
        }
        throw Error("Unexpected wallet request");
      },
    };
  }
  it("accepts the selected network and normalizes decimal/string IDs without prompting", async () => {
    const p = wallet({ chain: "0x7a69" });
    await selectWalletChain(p, { ...deployment, chainId: "31337" });
    assert.deepEqual(
      p.calls.map((c) => c.method),
      ["eth_chainId"]
    );
  });
  it("requests a switch from the actual selected network and verifies the result", async () => {
    const p = wallet();
    await selectWalletChain(p, deployment);
    assert.deepEqual(
      p.calls.map((c) => c.method),
      ["eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]
    );
    assert.equal(p.calls[1].params[0].chainId, "0x7a69");
  });
  it("adds an unknown local network with the correct RPC, then explicitly switches", async () => {
    const p = wallet({ unknown: true });
    await selectWalletChain(p, deployment);
    assert.deepEqual(
      p.calls.map((c) => c.method),
      [
        "eth_chainId",
        "wallet_switchEthereumChain",
        "wallet_addEthereumChain",
        "wallet_switchEthereumChain",
        "eth_chainId",
      ]
    );
    assert.equal(p.calls[2].params[0].rpcUrls[0], "http://127.0.0.1:8545");
  });
  it("reports rejection without bypassing the user's choice", async () => {
    const p = wallet({ error: { code: 4001 } });
    await assert.rejects(selectWalletChain(p, deployment), /declined/);
    assert.equal(p.calls.length, 2);
  });
  it("reports pending wallet prompts instead of starting another operation", async () => {
    await assert.rejects(
      selectWalletChain(wallet({ error: { code: -32002 } }), deployment),
      /already pending/
    );
  });
  it("rejects a wallet that claims to switch but remains on a different chain", async () => {
    await assert.rejects(
      selectWalletChain(wallet({ switchWorks: false }), deployment),
      /Wallet is on chain 1/
    );
    await assert.rejects(
      checkWalletChain(wallet(), deployment),
      /Connect wallet/
    );
  });
  it("does not guess RPC settings for an unknown nonlocal chain", async () => {
    const p = wallet({ unknown: true });
    await assert.rejects(
      selectWalletChain(p, { chainId: 42, network: "custom" }),
      /Add chain 42/
    );
    assert.equal(
      p.calls.some((c) => c.method === "wallet_addEthereumChain"),
      false
    );
  });
  it("reports a missing wallet explicitly", async () => {
    await assert.rejects(
      selectWalletChain(undefined, deployment),
      /Install MetaMask/
    );
  });
});
