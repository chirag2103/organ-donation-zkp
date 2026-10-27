"use strict";
const fs = require("fs"),
  path = require("path");
const { config } = require("./config");
const { Chain } = require("./chain");
const { Store } = require("./store");
const { wrappingKey } = require("./crypto");
const { BfvService } = require("./bfvService");
const { IpfsStorage } = require("./storage");
const { Auth } = require("./auth");
const { RecordService } = require("./service");
const { RevocationWorker } = require("./revocation");
const { createApp } = require("./app");
async function start(overrides = {}) {
  if (process.env.ADMIN_PRIVATE_KEY)
    throw Error(
      "Start the API without ADMIN_PRIVATE_KEY; use a separate administrator process"
    );
  const cfg = config(overrides),
    chain = new Chain(cfg);
  await chain.validate();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(cfg.root, "src/public/zkp/v2/manifest.json"))
  );
  const namespace = chain.deployment.deployedBlockHash.slice(2, 18);
  const store = new Store(path.join(cfg.dataDir, namespace, "service.sqlite"));
  if (!store.get("keys", "bfv-v1") && (await chain.hasRecords())) {
    store.close();
    chain.close();
    throw Error(
      "Existing on-chain records but BFV key metadata is missing; restore the database backup"
    );
  }
  const binding = store.get("meta", "deployment");
  if (binding && binding.hash !== chain.deployment.deployedBlockHash)
    throw Error("Data belongs to another deployment");
  store.put("meta", "deployment", { hash: chain.deployment.deployedBlockHash });
  const key = wrappingKey(cfg.wrappingKey),
    bfv = await new BfvService().init(store, key);
  const storage = await new IpfsStorage().init(cfg.ipfsUrl),
    protocol = await import("../shared/protocol.mjs");
  const auth = new Auth(store, chain, cfg.origin),
    records = new RecordService({
      store,
      chain,
      storage,
      bfv,
      wrappingKey: key,
      protocol,
    });
  const worker = new RevocationWorker({
    store,
    chain,
    storage,
    confirmations: cfg.confirmations,
  });
  const app = createApp({
    config: cfg,
    store,
    chain,
    auth,
    records,
    storage,
    protocol,
    manifest,
  });
  const server = app.listen(cfg.port, "127.0.0.1", () =>
    console.log(
      "Research v2 API listening on loopback port",
      server.address().port
    )
  );
  const tick = async () => {
    try {
      await worker.tick();
      await chain.keeper();
    } catch (e) {
      console.error("Worker unavailable; durable jobs will retry");
    }
  };
  const timer = setInterval(tick, 5000);
  await tick();
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await new Promise((resolve) => server.close(resolve));
    chain.close();
    bfv.close();
    store.close();
    key.fill(0);
  }
  return { app, server, store, chain, bfv, records, worker, close };
}
if (require.main === module)
  start()
    .then((runtime) => {
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, () => runtime.close().then(() => process.exit(0)));
    })
    .catch((e) => {
      console.error("Startup failed:", e.message);
      process.exit(1);
    });
module.exports = { start };
