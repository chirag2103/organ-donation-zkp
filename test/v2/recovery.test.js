const { expect } = require("chai");
const fs = require("fs"),
  os = require("os"),
  path = require("path");
const { Store } = require("../../server/store");
const { RevocationWorker } = require("../../server/revocation");
describe("Durable revocation recovery", function () {
  let folder, file, store, chain, storage, removed, now;
  const id = "0x" + "ab".repeat(32);
  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "organ-v2-"));
    file = path.join(folder, "db.sqlite");
    store = new Store(file);
    removed = [];
    now = 100000;
    chain = {
      deployment: { deployedBlock: 1 },
      head: async () => 12,
      block: async (n) => ({ hash: "block-" + n }),
      record: async () => ({ active: false }),
      events: async (from, to) =>
        from <= 10 && to >= 10
          ? [
              {
                kind: "RevocationExecuted",
                id,
                blockNumber: 10,
                blockHash: "block-10",
                index: 0,
              },
            ]
          : [],
    };
    storage = { remove: async (cid) => removed.push(cid) };
    store.put("records", id, {
      cid: "canonical-cid",
      wrappedKey: "encrypted-key",
      state: "active",
    });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  it("replays events missed during downtime, deletes canonical key and is idempotent after restart", async () => {
    store.close();
    store = new Store(file);
    const worker = new RevocationWorker({
      store,
      chain,
      storage,
      clock: () => now,
    });
    await worker.tick();
    expect(store.get("records", id)).not.to.have.property("wrappedKey");
    expect(removed).to.deep.equal(["canonical-cid"]);
    expect(store.get("revocations", id).state).to.equal("completed locally");
    store.close();
    store = new Store(file);
    await new RevocationWorker({ store, chain, storage }).tick();
    expect(removed).to.have.length(1);
  });
  it("persists failed cleanup, retries after backoff and never reports GC failure as completion", async () => {
    let failing = true;
    storage.remove = async (cid) => {
      if (failing) throw Error("GC unavailable");
      removed.push(cid);
    };
    const worker = new RevocationWorker({
      store,
      chain,
      storage,
      clock: () => now,
    });
    await worker.tick();
    expect(store.get("revocations", id).state).to.equal("failed");
    expect(store.get("records", id)).not.to.have.property("wrappedKey");
    failing = false;
    await worker.tick();
    expect(removed).to.have.length(0);
    now += 10000;
    await worker.tick();
    expect(store.get("revocations", id).state).to.equal("completed locally");
  });
  it("waits for required confirmation depth before deleting a record key", async () => {
    const worker = new RevocationWorker({
      store,
      chain,
      storage,
      confirmations: 6,
    });
    await worker.tick();
    expect(store.get("records", id)).to.have.property("wrappedKey");
    expect(removed).to.have.length(0);
  });
  it("does not delete keys if canonical chain still says active", async () => {
    chain.record = async () => ({ active: true });
    await new RevocationWorker({ store, chain, storage }).tick();
    expect(store.get("records", id)).to.have.property("wrappedKey");
    expect(store.get("revocations", id).state).to.equal("failed");
  });
  it("halts irreversible cleanup when processed block history changes", async () => {
    store.put("worker", "cursor", { block: 9, hash: "previous-chain-hash" });
    let failed = false;
    try {
      await new RevocationWorker({ store, chain, storage }).tick();
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    expect(store.get("worker", "reorg")).to.have.property("message");
    expect(store.get("records", id)).to.have.property("wrappedKey");
    expect(removed).to.have.length(0);
  });
});
