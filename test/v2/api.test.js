const { expect } = require("chai");
const { ethers } = require("ethers");
const { Store } = require("../../server/store");
const { Auth } = require("../../server/auth");
const { BfvService } = require("../../server/bfvService");
const { RecordService } = require("../../server/service");
const { createApp } = require("../../server/app");
describe("HTTP authorization and restricted matching interfaces", function () {
  this.timeout(30000);
  let store,
    chain,
    auth,
    bfv,
    service,
    server,
    base,
    protocol,
    states,
    storage,
    wallets;
  const key = Buffer.alloc(32, 6),
    attributes = { abo: "O", features: [0, 0, 0, 0, 0, 0], urgency: 0 };
  before(async () => {
    protocol = await import("../../shared/protocol.mjs");
  });
  beforeEach(async () => {
    store = new Store(":memory:");
    states = new Map();
    wallets = [
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
    ];
    const chainRecords = new Map();
    chain = {
      deployment: {
        chainId: 31337,
        PFEKeyIssuer: ethers.Wallet.createRandom().address,
      },
      authorization: async (a) => states.get(a) || { valid: false },
      record: async (id) =>
        chainRecords.get(id) || { active: false, timestamp: 0 },
      validate: async () => true,
      roles: { roots: async () => 123n, versions: async () => 1n },
      revocationStatus: async () => 0,
      chainRecords,
    };
    const blobs = new Map();
    storage = {
      put: async (data) => {
        const id = "bafy" + ethers.keccak256(data).slice(2);
        blobs.set(id, data);
        return id;
      },
      get: async (id) => blobs.get(id),
      remove: async (id) => blobs.delete(id),
      health: async () => true,
      blobs,
    };
    bfv = await new BfvService().init(store, key);
    auth = new Auth(store, chain, "http://localhost:5173");
    service = new RecordService({
      store,
      chain,
      storage,
      bfv,
      wrappingKey: key,
      protocol,
    });
    const app = createApp({
      config: { origin: "http://localhost:5173", network: "test" },
      store,
      chain,
      auth,
      records: service,
      storage,
      protocol,
      manifest: {},
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    bfv.close();
    store.close();
  });
  async function request(
    url,
    body,
    token,
    method = body === undefined ? "GET" : "POST"
  ) {
    const response = await fetch(base + url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function login(wallet, role = 0) {
    states.set(wallet.address, {
      valid: true,
      roleId: role,
      expiresAt: Math.floor(Date.now() / 1000) + 14400,
      rootVersion: 1,
    });
    const c = (
      await request("/api/auth/challenge", { address: wallet.address })
    ).body;
    return (
      await request("/api/auth/session", {
        nonce: c.nonce,
        signature: await wallet.signMessage(c.message),
      })
    ).body.token;
  }
  async function record(wallet, token, type, a = attributes) {
    const prepared = await request(
      "/api/records",
      { entityType: type, attributes: a },
      token
    );
    expect(prepared.status).to.equal(201);
    const r = prepared.body;
    chain.chainRecords.set(r.id, {
      active: true,
      timestamp: 1,
      entityType: type,
      anchor: r.anchor,
      registeredBy: wallet.address,
    });
    expect(
      (await request("/api/records/" + r.id + "/confirm", {}, token)).status
    ).to.equal(200);
    return r;
  }
  it("does not expose enrollment, proving, arbitrary decrypt/download or direct unpin APIs", async () => {
    for (const [url, method] of [
      ["/api/zkp/generate-and-register", "POST"],
      ["/api/dev/register-root", "POST"],
      ["/api/pfe/decrypt", "POST"],
      ["/api/ipfs/unpin/bafy", "DELETE"],
      ["/api/ipfs/download/bafy", "GET"],
    ]) {
      expect(
        (
          await request(
            url,
            method === "POST" ? {} : undefined,
            undefined,
            method
          )
        ).status
      ).to.equal(404);
    }
    expect((await request("/api/matches/evaluate", {})).status).to.equal(401);
  });
  it("requires an approved on-chain session and consumes challenges once, including bad signatures", async () => {
    const wallet = wallets[0],
      c = (await request("/api/auth/challenge", { address: wallet.address }))
        .body;
    const signature = await wallet.signMessage(c.message);
    expect(
      (await request("/api/auth/session", { nonce: c.nonce, signature })).status
    ).to.equal(403);
    expect(
      (await request("/api/auth/session", { nonce: c.nonce, signature })).status
    ).to.equal(401);
    const other = (
      await request("/api/auth/challenge", { address: wallet.address })
    ).body;
    expect(
      (
        await request("/api/auth/session", {
          nonce: other.nonce,
          signature: await wallets[1].signMessage(other.message),
        })
      ).status
    ).to.equal(401);
  });
  it("rejects an expired challenge and enforces session expiry and changed authorization", async () => {
    const c = await auth.challenge(wallets[0].address);
    const stored = store.get("challenges", c.nonce);
    stored.expiresAt = 0;
    store.put("challenges", c.nonce, stored);
    expect(
      (
        await request("/api/auth/session", {
          nonce: c.nonce,
          signature: await wallets[0].signMessage(c.message),
        })
      ).status
    ).to.equal(401);
    const token = await login(wallets[0]);
    states.get(wallets[0].address).rootVersion = 2;
    expect((await request("/api/records", undefined, token)).status).to.equal(
      403
    );
    states.get(wallets[0].address).rootVersion = 1;
    states.get(wallets[0].address).valid = false;
    expect((await request("/api/records", undefined, token)).status).to.equal(
      403
    );
    const token2 = await login(wallets[1]);
    const id = require("../../server/crypto").digest(token2),
      s = store.get("sessions", id);
    s.expiresAt = 0;
    store.put("sessions", id, s);
    expect((await request("/api/records", undefined, token2)).status).to.equal(
      401
    );
  });
  it("enforces transporter/procurement permissions and rejects attacker-selected fields", async () => {
    const transport = await login(wallets[0], 4),
      procurement = await login(wallets[1], 2);
    expect(
      (await request("/api/records", { entityType: 0, attributes }, transport))
        .status
    ).to.equal(403);
    expect(
      (await request("/api/matches/evaluate", {}, transport)).status
    ).to.equal(403);
    expect(
      (
        await request(
          "/api/records",
          { entityType: 1, attributes },
          procurement
        )
      ).status
    ).to.equal(403);
    expect(
      (
        await request(
          "/api/matches/evaluate",
          { donorId: "x", recipientId: "y", encryptedScore: "attacker" },
          procurement
        )
      ).status
    ).to.equal(400);
  });
  it("stores no plaintext attributes, returns only approved results and denies inactive records immediately", async () => {
    const token = await login(wallets[0]);
    const d = await record(wallets[0], token, 0);
    const r = await record(wallets[0], token, 1, {
      ...attributes,
      abo: "A",
      urgency: 2,
    });
    const stored = JSON.stringify(store.list("records"));
    expect(stored).not.to.include("features");
    expect(stored).not.to.include("urgency");
    const blob = (await storage.get(store.get("records", d.id).cid)).toString();
    expect(blob).not.to.include("features");
    const result = await request(
      "/api/matches/evaluate",
      { donorId: d.id, recipientId: r.id },
      token
    );
    expect(result.body).to.include({ eligible: true, score: 1000 });
    expect(result.body).not.to.have.property("ciphertexts");
    chain.chainRecords.get(d.id).active = false;
    expect(
      (
        await request(
          "/api/matches/evaluate",
          { donorId: d.id, recipientId: r.id },
          token
        )
      ).status
    ).to.equal(409);
  });
  it("loads each encrypted record once per batch without sharing a cache across jobs", async () => {
    const token = await login(wallets[0]);
    const d1 = await record(wallets[0], token, 0),
      d2 = await record(wallets[0], token, 0);
    const r = await record(wallets[0], token, 1);
    let reads = 0;
    const originalGet = storage.get;
    storage.get = async (cid) => {
      reads++;
      return originalGet(cid);
    };
    for (let batch = 0; batch < 2; batch++) {
      const job = await request(
        "/api/matches/jobs",
        { donorIds: [d1.id, d2.id], recipientIds: [r.id] },
        token
      );
      expect(job.status).to.equal(202);
      let result;
      for (let i = 0; i < 100; i++) {
        result = await request(
          "/api/matches/jobs/" + job.body.id,
          undefined,
          token
        );
        if (result.body.state === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(result.body.results).to.have.length(2);
      expect(reads).to.equal((batch + 1) * 3);
    }
  });
  it("keeps batch ownership, rechecks activity and rejects oversized batches", async () => {
    const token = await login(wallets[0]),
      other = await login(wallets[1]);
    const d = await record(wallets[0], token, 0),
      r = await record(wallets[0], token, 1);
    expect(
      (
        await request(
          "/api/matches/jobs",
          { donorIds: Array(11).fill(d.id), recipientIds: [r.id] },
          token
        )
      ).status
    ).to.equal(400);
    const job = await request(
      "/api/matches/jobs",
      { donorIds: [d.id], recipientIds: [r.id] },
      token
    );
    expect(job.status).to.equal(202);
    expect(
      (await request("/api/matches/jobs/" + job.body.id, undefined, other))
        .status
    ).to.equal(403);
    let got;
    for (let i = 0; i < 50; i++) {
      got = await request("/api/matches/jobs/" + job.body.id, undefined, token);
      if (got.body.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(got.body.results[0].score).to.equal(700);
    chain.chainRecords.get(r.id).active = false;
    expect(
      (await request("/api/matches/jobs/" + job.body.id, undefined, token))
        .status
    ).to.equal(409);
  });
});
