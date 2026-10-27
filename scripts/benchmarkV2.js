"use strict";
const hre = require("hardhat"),
  { ethers } = hre;
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  crypto = require("crypto"),
  { execFileSync, spawn } = require("child_process");
const snarkjs = require("snarkjs");
const { Store } = require("../server/store"),
  { BfvService } = require("../server/bfvService");
const { Auth } = require("../server/auth"),
  { RecordService } = require("../server/service");
const { IpfsStorage } = require("../server/storage"),
  { createApp } = require("../server/app");
const { RevocationWorker } = require("../server/revocation");
const root = path.resolve(__dirname, ".."),
  smoke = process.env.BENCHMARK_SMOKE === "1",
  out = path.join(
    root,
    smoke ? "runtime/benchmark-smoke" : "paper/evaluation-v2"
  );
fs.mkdirSync(out, { recursive: true });
const samples = smoke ? 2 : 30,
  warmups = smoke ? 1 : 10;
function stats(raw) {
  const sorted = [...raw].sort((a, b) => a - b),
    mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  return {
    samples: raw.length,
    median: sorted[Math.floor(raw.length / 2)],
    p95: sorted[Math.ceil(raw.length * 0.95) - 1],
    mean,
    std: Math.sqrt(
      raw.reduce((sum, x) => sum + (x - mean) ** 2, 0) / raw.length
    ),
    raw,
  };
}
async function measure(fn) {
  for (let i = 0; i < warmups; i++) await fn(i);
  const raw = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    await fn(i + warmups);
    raw.push(performance.now() - start);
  }
  return stats(raw);
}
const sha = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function main() {
  const protocol = await import("../shared/protocol.mjs"),
    [owner, doctor, surgeon] = await ethers.getSigners();
  const runtime = path.join(root, "runtime", "benchmark-" + Date.now());
  fs.mkdirSync(runtime, { recursive: true });
  let ipfsProcess, server;
  const store = new Store(path.join(runtime, "benchmark.sqlite"));
  let bfv;
  const output = {
    meta: {
      date: new Date().toISOString(),
      profile: smoke ? "smoke-not-research-evidence" : "research",
      samples,
      warmups,
      jobPollIntervalMs: 100,
      httpTransport:
        "Connection: close; idempotent GET transport failures retried at most twice with 100-ms backoff; POST never replayed",
      transportRetries: [],
      dataset:
        "Fixed donor/recipient feature vectors and cycling recipient urgency; opaque record IDs are random",
      enrollmentNote:
        "Enrollment samples include adding one member to a progressively growing approved tree",
      node: process.version,
      platform: process.platform,
      osRelease: os.release(),
      architecture: os.arch(),
      cpu: os.cpus()[0].model,
      totalMemoryBytes: os.totalmem(),
      commit: execFileSync(
        "git",
        [
          "-c",
          "safe.directory=" + root.replaceAll("\\", "/"),
          "rev-parse",
          "HEAD",
        ],
        { encoding: "utf8" }
      ).trim(),
      workingTree: true,
      packageLockHash: sha(path.join(root, "package-lock.json")),
      dependencyVersions: Object.fromEntries(
        [
          "hardhat",
          "ethers",
          "snarkjs",
          "node-seal",
          "express",
          "react",
          "vite",
        ].map((name) => [
          name,
          JSON.parse(fs.readFileSync(path.join(root, "package-lock.json")))
            .packages["node_modules/" + name].version,
        ])
      ),
      artifactManifest: JSON.parse(
        fs.readFileSync("circuits/build/manifest-v2.json")
      ),
      sourceHashes: Object.fromEntries(
        [
          "server/app.js",
          "server/bfvService.js",
          "server/auth.js",
          "server/service.js",
          "server/storage.js",
          "server/store.js",
          "scripts/benchmarkV2.js",
          "contracts/RoleRegistry.sol",
          "contracts/PFEKeyIssuer.sol",
          "contracts/OrganRegistry.sol",
          "contracts/LifecycleManager.sol",
          "contracts/Groth16Verifier.sol",
          "shared/protocol.mjs",
          "circuits/roleProof.circom",
        ].map((p) => [p, sha(p)])
      ),
      baselineScope:
        "Same authenticated HTTP job interface. Plaintext baseline holds synthetic attributes in memory; BFV baselines retrieve AES-wrapped records from real isolated Kubo. Test-only quotas raised. Sequential single-process local execution; not consortium throughput.",
    },
    timings: {},
    gas: {},
    workloads: {},
  };
  try {
    const deploy = async (name, ...args) => {
      const f = await ethers.getContractFactory(name);
      const c = await f.deploy(...args);
      await c.waitForDeployment();
      return c;
    };
    const roles = await deploy("RoleRegistry"),
      inner = await deploy("contracts/Groth16Verifier.sol:Groth16Verifier"),
      verifier = await deploy("ZKPVerifier", inner.target);
    const issuer = await deploy("PFEKeyIssuer", verifier.target, roles.target),
      registry = await deploy("OrganRegistry", issuer.target),
      lifecycle = await deploy(
        "LifecycleManager",
        registry.target,
        issuer.target
      );
    await registry.setLifecycleManager(lifecycle.target);
    const rbac = await deploy("WalletRBAC");
    const enrollReceipt = await (await rbac.enroll(doctor.address)).wait();
    output.gas.walletRbacEnroll = Number(enrollReceipt.gasUsed);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const secret = 123456789123456789n,
      leaf = protocol.hash(secret, 0).toString();
    let leaves = [leaf];
    const enrollGas = [];
    output.timings.enrollment = await measure(async (i) => {
      const proposed = [
        ...leaves,
        protocol.hash(BigInt(i + 999), 0).toString(),
      ];
      const r = await (
        await roles.registerCredentialRoot(0, protocol.tree(proposed).root)
      ).wait();
      enrollGas.push(Number(r.gasUsed));
      leaves = proposed;
    });
    output.gas.enrollment = stats(enrollGas.slice(warmups));
    const base = {
      credential: secret.toString(),
      roleId: 0,
      recipient: doctor.address,
      chainId,
      issuer: issuer.target,
      rootVersion: await roles.versions(0),
      leaves,
    };
    const wasm = path.join(root, "circuits/build/roleProof_js/roleProof.wasm"),
      zkey = path.join(root, "circuits/build/roleProof_v2_final.zkey");
    let last;
    output.timings.membershipPath = await measure(() =>
      protocol.proofInput({ ...base, salt: "777" })
    );
    console.log(
      "Benchmark:",
      warmups,
      "warmups +",
      samples,
      "measured real Groth16 proofs"
    );
    output.timings.proofGeneration = await measure(async (i) => {
      const input = protocol.proofInput({ ...base, salt: String(i + 888) });
      last = await snarkjs.groth16.fullProve(input, wasm, zkey);
      if (i % 10 === 0) console.log("Proof sample", i);
    });
    const proofs = [];
    for (let i = 0; i < warmups + samples; i++) {
      const input = protocol.proofInput({ ...base, salt: String(i + 9000) });
      const p = await snarkjs.groth16.fullProve(input, wasm, zkey);
      proofs.push(
        JSON.parse(
          "[" +
            (await snarkjs.groth16.exportSolidityCallData(
              p.proof,
              p.publicSignals
            )) +
            "]"
        )
      );
    }
    const verificationGas = [],
      verifyTimes = [];
    for (const p of proofs) {
      const start = performance.now();
      const receipt = await (
        await issuer.connect(doctor).verifyAndIssueKey(0, ...p)
      ).wait();
      verifyTimes.push(performance.now() - start);
      verificationGas.push(Number(receipt.gasUsed));
    }
    output.gas.initialVerificationIssuance = verificationGas[0];
    output.gas.verifyAndIssue = stats(verificationGas.slice(warmups));
    output.timings.verifyTransactionLocal = stats(verifyTimes.slice(warmups));
    const wrapKey = crypto.randomBytes(32);
    bfv = await new BfvService().init(store, wrapKey);
    const d = { abo: "O", features: [1, 0, 1, 0, 1, 0], urgency: 0 },
      r = { abo: "A", features: [1, 1, 1, 0, 0, 0], urgency: 2 };
    let dc = bfv.encryptAttributes(d),
      rc = bfv.encryptAttributes(r),
      evaluated;
    output.timings.bfvEncrypt = await measure(() => bfv.encryptAttributes(d));
    output.timings.bfvEvaluate = await measure(() => {
      evaluated = bfv.evaluate(dc, rc);
    });
    output.timings.bfvRelease = await measure(() => bfv.release(evaluated));
    output.timings.plaintextPolicy = await measure(() =>
      protocol.referenceScore(d, r)
    );
    output.timings.walletSignatureCheck = await measure(async (i) => {
      const message = "benchmark-domain-" + i,
        sig = await doctor.signMessage(message);
      ethers.verifyMessage(message, sig);
    });
    const ipfs =
      process.env.IPFS_BINARY ||
      execFileSync("where.exe", ["ipfs"], {
        encoding: "utf8",
        windowsHide: true,
      })
        .trim()
        .split(/\r?\n/)[0];
    const ipfsEnv = { ...process.env, IPFS_PATH: path.join(runtime, "ipfs") };
    output.meta.kuboVersion = execFileSync(ipfs, ["version"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    execFileSync(ipfs, ["init", "--profile=test"], {
      env: ipfsEnv,
      stdio: "ignore",
      windowsHide: true,
    });
    for (const [k, v] of Object.entries({
      "Addresses.API": "/ip4/127.0.0.1/tcp/15002",
      "Addresses.Gateway": "/ip4/127.0.0.1/tcp/18082",
    }))
      execFileSync(ipfs, ["config", k, v], {
        env: ipfsEnv,
        stdio: "ignore",
        windowsHide: true,
      });
    ipfsProcess = spawn(ipfs, ["daemon", "--offline"], {
      env: ipfsEnv,
      stdio: "ignore",
      windowsHide: true,
    });
    const storage = await new IpfsStorage().init("http://127.0.0.1:15002");
    for (let i = 0; i < 100 && !(await storage.health()); i++)
      await new Promise((resolve) => setTimeout(resolve, 200));
    if (!(await storage.health())) throw Error("Benchmark Kubo unavailable");
    const chain = {
      deployment: {
        chainId: Number(chainId),
        PFEKeyIssuer: issuer.target,
        deployedBlock: 0,
      },
      validate: async () => true,
      roles,
      record: async (id) => {
        const c = await registry.records(id);
        return {
          anchor: c.anchor,
          entityType: Number(c.entityType),
          active: c.active,
          registeredBy: c.registeredBy,
          timestamp: Number(c.timestamp),
        };
      },
      authorization: async (address) => {
        const [valid, roleId, expiresAt] = await issuer.isKeyValid(address),
          s = await issuer.sessions(address);
        return {
          valid,
          roleId: Number(roleId),
          expiresAt: Number(expiresAt),
          rootVersion: Number(s.rootVersion),
        };
      },
      revocationStatus: async (id) => Number(await lifecycle.status(id)),
    };
    const service = new RecordService({
      store,
      chain,
      storage,
      bfv,
      wrappingKey: wrapKey,
      protocol,
    });
    const ids = [[], []],
      plain = new Map(),
      registrationGas = [];
    for (let type = 0; type < 2; type++)
      for (let i = 0; i < 10; i++) {
        const a = type === 0 ? d : { ...r, urgency: i % 3 };
        const rec = await service.prepare(doctor.address, type, a);
        const receipt = await (
          await registry
            .connect(doctor)
            .registerRecord(rec.id, rec.anchor, type)
        ).wait();
        registrationGas.push(Number(receipt.gasUsed));
        await service.confirm(rec.id, doctor.address);
        ids[type].push(rec.id);
        plain.set(rec.id, a);
      }
    output.gas.recordRegistration = stats(registrationGas);
    output.timings.encryptedStorageRoundTrip = await measure(async () => {
      const rec = await service.canonical(ids[0][0]);
      await service.bundle(ids[0][0], rec);
    });
    let mode = "zkp";
    const benchmarkChain = {
      ...chain,
      authorization: async (address) => {
        if (mode === "zkp") return chain.authorization(address);
        return {
          valid: await rbac.approved(address),
          roleId: 0,
          expiresAt: Math.floor(Date.now() / 1000) + 14400,
          rootVersion: 1,
        };
      },
    };
    const benchmarkService = Object.create(service);
    benchmarkService.evaluate = async (donorId, recipientId, bundleCache) => {
      if (mode !== "plain")
        return service.evaluate(donorId, recipientId, bundleCache);
      await service.canonical(donorId);
      await service.canonical(recipientId);
      return {
        donorId,
        recipientId,
        ...protocol.referenceScore(plain.get(donorId), plain.get(recipientId)),
        policy: "synthetic-v2",
      };
    };
    const auth = new Auth(store, benchmarkChain, "http://benchmark.local");
    const app = createApp({
      config: { origin: "http://benchmark.local", network: "benchmark" },
      store,
      chain: benchmarkChain,
      auth,
      records: benchmarkService,
      storage,
      protocol,
      manifest: {},
      limits: {
        requests: 1000000,
        expensiveRequests: 1000000,
        batchPairs: 1000000,
      },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = "http://127.0.0.1:" + server.address().port;
    async function request(endpoint, body, token) {
      let response;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await fetch(url + endpoint, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              "Content-Type": "application/json",
              Connection: "close",
              ...(token ? { Authorization: "Bearer " + token } : {}),
            },
            signal: AbortSignal.timeout(60000),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          break;
        } catch (error) {
          if (body !== undefined || attempt >= 2) throw error;
          output.meta.transportRetries.push({
            endpoint,
            attempt: attempt + 1,
            cause: error.cause?.code || error.message,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const value = await response.json();
      if (!response.ok) throw Error(JSON.stringify(value));
      return value;
    }
    for (const [name, kind] of [
      ["plaintextWalletRbac", "plain"],
      ["bfvWalletRbac", "rbac"],
      ["bfvZkpAuthorization", "zkp"],
    ]) {
      mode = kind;
      const challenge = await request("/api/auth/challenge", {
        address: doctor.address,
      });
      const session = await request("/api/auth/session", {
        nonce: challenge.nonce,
        signature: await doctor.signMessage(challenge.message),
      });
      output.workloads[name] = {};
      for (const n of [1, 5, 10]) {
        console.log(
          "Benchmark authenticated HTTP batches:",
          name,
          n + "x" + n,
          `${warmups} warmups + ${samples} samples`
        );
        output.workloads[name][n + "x" + n] = await measure(
          async (iteration) => {
            const job = await request(
              "/api/matches/jobs",
              {
                donorIds: ids[0].slice(0, n),
                recipientIds: ids[1].slice(0, n),
              },
              session.token
            );
            let state;
            do {
              await new Promise((resolve) => setTimeout(resolve, 100));
              state = await request(
                "/api/matches/jobs/" + job.id,
                undefined,
                session.token
              );
            } while (["queued", "running"].includes(state.state));
            if (state.state !== "completed" || state.results.length !== n * n)
              throw Error("Batch failed");
            if (iteration % 10 === 0)
              console.log(name, n + "x" + n, "sample", iteration);
          }
        );
        fs.writeFileSync(
          path.join(out, "benchmark-v2.partial.json"),
          JSON.stringify(output, null, 2)
        );
      }
    }
    // Authorize a real surgeon proof for request/execution gas and cleanup timing.
    const surgeonLeaf = protocol.hash(11223344n, 5).toString();
    await roles.registerCredentialRoot(5, protocol.tree([surgeonLeaf]).root);
    const surgeonInput = protocol.proofInput({
      credential: "11223344",
      salt: "4242",
      roleId: 5,
      recipient: surgeon.address,
      chainId,
      issuer: issuer.target,
      rootVersion: 1,
      leaves: [surgeonLeaf],
    });
    const p = await snarkjs.groth16.fullProve(surgeonInput, wasm, zkey),
      args = JSON.parse(
        "[" +
          (await snarkjs.groth16.exportSolidityCallData(
            p.proof,
            p.publicSignals
          )) +
          "]"
      );
    await issuer.connect(surgeon).verifyAndIssueKey(5, ...args);
    const revocation = {
      requestMs: [],
      executionMs: [],
      cleanupMs: [],
      requestGas: [],
      executionGas: [],
    };
    console.log(
      "Benchmark revocation:",
      warmups,
      "warmups +",
      samples,
      "measured donor/recipient records"
    );
    for (let i = 0; i < warmups + samples; i++) {
      const type = i % 2;
      const prepared = await service.prepare(
        doctor.address,
        type,
        type ? r : d
      );
      await (
        await registry
          .connect(doctor)
          .registerRecord(prepared.id, prepared.anchor, type)
      ).wait();
      await service.confirm(prepared.id, doctor.address);
      const requestStart = performance.now();
      const req = await (
        await lifecycle.connect(surgeon).requestRevocation(prepared.id)
      ).wait();
      revocation.requestMs.push(performance.now() - requestStart);
      revocation.requestGas.push(Number(req.gasUsed));
      const executionStart = performance.now();
      const exe = await (
        await lifecycle.connect(surgeon).executeRevocation(prepared.id)
      ).wait();
      revocation.executionMs.push(performance.now() - executionStart);
      revocation.executionGas.push(Number(exe.gasUsed));
      const cleanupStart = performance.now();
      const rec = store.get("records", prepared.id);
      delete rec.wrappedKey;
      store.put("records", prepared.id, rec);
      await storage.remove(rec.cid);
      revocation.cleanupMs.push(performance.now() - cleanupStart);
    }
    output.timings.revocationRequestLocal = stats(
      revocation.requestMs.slice(warmups)
    );
    output.timings.revocationExecutionLocal = stats(
      revocation.executionMs.slice(warmups)
    );
    output.timings.localCleanup = stats(revocation.cleanupMs.slice(warmups));
    output.gas.revocationRequest = stats(revocation.requestGas.slice(warmups));
    output.gas.revocationExecution = stats(
      revocation.executionGas.slice(warmups)
    );
    output.meta.completedAt = new Date().toISOString();
    output.meta.complete = true;
    fs.writeFileSync(
      path.join(out, "benchmark-v2.json"),
      JSON.stringify(output, null, 2)
    );
    const rows = Object.entries(output.timings)
      .filter(([, v]) => typeof v === "object")
      .map(
        ([k, v]) =>
          `| ${k} | ${v.samples} | ${v.median.toFixed(3)} | ${v.p95.toFixed(
            3
          )} |`
      );
    for (const [baseline, workloads] of Object.entries(output.workloads))
      for (const [size, v] of Object.entries(workloads))
        rows.push(
          `| HTTP ${baseline} ${size} | ${v.samples} | ${v.median.toFixed(
            3
          )} | ${v.p95.toFixed(3)} |`
        );
    fs.writeFileSync(
      path.join(out, "benchmark-v2.md"),
      "# Protocol v2 measured evaluation\n\n" +
        output.meta.baselineScope +
        `\n\nRepeated timing metrics use ${warmups} warmups and ${samples} measured samples. Node proving includes path construction and is not browser latency. Transaction receipt timings are local EVM diagnostics; cold issuance gas is recorded separately from warmed verification samples. Revocation alternates donor and recipient records and measures request, execution and direct local cleanup separately. The cleanup benchmark excludes worker discovery/retry delay, which is covered by recovery tests. Job timings include 100-ms result polling and fresh HTTP connections. Any idempotent polling retries remain in the measured latency and are recorded in JSON metadata.\n\n| Metric | Samples | Median ms | p95 ms |\n|---|---:|---:|---:|\n` +
        rows.join("\n") +
        "\n\nGas, variability and raw timing samples are in benchmark-v2.json. Initial dataset registration gas has 20 samples; repeated timing metrics use the sample counts above.\n"
    );
    console.log("Completed benchmark:", path.join(out, "benchmark-v2.json"));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    bfv?.close();
    store.close();
    ipfsProcess?.kill();
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.stack);
    if (e.cause) console.error("Underlying cause:", e.cause);
    process.exit(1);
  });
