"use strict";
// Isolated, real-chain + browser + Kubo acceptance demonstration. Synthetic wallets only.
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { ethers } = require("ethers");
const { chromium, expect } = require("@playwright/test");
const root = path.resolve(__dirname, "..");
const runDir = path.join(root, "runtime", "e2e-" + Date.now());
fs.mkdirSync(runDir, { recursive: true });
const env = {
  ...process.env,
  NETWORK: "e2e",
  RPC_URL: "http://127.0.0.1:18545",
  PORT: "13001",
  APP_ORIGIN: "http://localhost:14173",
  IPFS_API_URL: "http://127.0.0.1:15001",
  DATA_DIR: runDir,
  WRAPPING_KEY: crypto.randomBytes(32).toString("hex"),
  CONFIRMATIONS: "1",
  VITE_API_URL: "http://127.0.0.1:13001",
};
const children = [];
let browser, provider, lastPage;
function launch(name, command, args, overrides = {}) {
  const log = fs.openSync(path.join(runDir, name + ".log"), "a");
  const child = spawn(command, args, {
    cwd: root,
    env: { ...env, ...overrides },
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  children.push(child);
  return child;
}
async function command(name, executable, args) {
  const child = launch(name, executable, args);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(name + " failed; see " + path.join(runDir, name + ".log"))
          )
    );
  });
}
const node = (name, args) => command(name, process.execPath, args);
async function ready(label, fn, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw Error(label + " not ready");
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}
async function main() {
  const evidence = {
    startedAt: new Date().toISOString(),
    checks: [],
    infrastructure: "real local Hardhat + isolated Kubo + Edge browser",
  };
  const ipfs =
    process.env.IPFS_BINARY ||
    execFileSync("where.exe", ["ipfs"], { encoding: "utf8", windowsHide: true })
      .trim()
      .split(/\r?\n/)[0];
  env.IPFS_PATH = path.join(runDir, "ipfs");
  await command("ipfs-init", ipfs, ["init", "--profile=test"]);
  for (const [key, value] of Object.entries({
    "Addresses.API": "/ip4/127.0.0.1/tcp/15001",
    "Addresses.Gateway": "/ip4/127.0.0.1/tcp/18080",
  }))
    await command("ipfs-config", ipfs, ["config", key, value]);
  const ipfsProcess = launch("ipfs", ipfs, ["daemon", "--offline"]);
  await ready(
    "Kubo",
    async () =>
      (
        await fetch(env.IPFS_API_URL + "/api/v0/version", { method: "POST" })
      ).ok
  );
  launch("hardhat", process.execPath, [
    "node_modules/hardhat/internal/cli/cli.js",
    "node",
    "--hostname",
    "127.0.0.1",
    "--port",
    "18545",
  ]);
  provider = new ethers.JsonRpcProvider(env.RPC_URL, undefined, {
    cacheTimeout: -1,
  });
  await ready(
    "Hardhat",
    async () => (await provider.send("eth_chainId", [])) === "0x7a69"
  );
  await node("deploy", [
    "node_modules/hardhat/internal/cli/cli.js",
    "run",
    "scripts/deploy.js",
    "--network",
    "e2e",
  ]);
  let apiProcess = launch("api", process.execPath, ["server/index.js"]);
  await ready(
    "API",
    async () => (await fetch("http://127.0.0.1:13001/api/status")).ok
  );
  launch("vite", process.execPath, [
    "node_modules/vite/bin/vite.js",
    "--config",
    "vite.config.mjs",
    "--host",
    "127.0.0.1",
    "--port",
    "14173",
    "--strictPort",
  ]);
  await ready(
    "Frontend",
    async () => (await fetch("http://127.0.0.1:14173")).ok
  );
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  lastPage = page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error")
      fs.appendFileSync(
        path.join(runDir, "browser-errors.log"),
        m.text() + "\n"
      );
  });
  let accountIndex = 1;
  const wallet = () =>
    ethers.HDNodeWallet.fromPhrase(
      "test test test test test test test test test test test junk",
      undefined,
      "m/44'/60'/0'/0/" + accountIndex
    );
  await page.exposeFunction(
    "testWalletRequest",
    async ({ method, params = [] }) => {
      if (["eth_accounts", "eth_requestAccounts"].includes(method))
        return [wallet().address];
      if (method === "personal_sign")
        return wallet().signMessage(ethers.getBytes(params[0]));
      if (method === "eth_sign")
        return wallet().signMessage(ethers.getBytes(params[1]));
      return provider.send(method, params);
    }
  );
  await page.addInitScript(() => {
    const listeners = {};
    window.ethereum = {
      request: (args) => window.testWalletRequest(args),
      on: (name, fn) => {
        (listeners[name] ??= []).push(fn);
      },
      removeListener: (name, fn) => {
        listeners[name] = (listeners[name] || []).filter((x) => x !== fn);
      },
      emitTestEvent: (name, value) =>
        (listeners[name] || []).forEach((fn) => fn(value)),
    };
  });
  const requests = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/"))
      requests.push({ url: req.url(), body: req.postData() || "" });
  });
  await page.goto("http://localhost:14173");
  await expect(
    page.getByRole("button", { name: "Connect wallet", exact: true })
  ).toBeEnabled({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  async function credential(role) {
    await page.getByRole("button", { name: "access", exact: true }).click();
    await page.getByLabel("Role", { exact: true }).selectOption(String(role));
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Create and download credential" })
      .click();
    const file = path.join(runDir, "credential-role-" + role + ".json");
    await (await download).saveAs(file);
    return JSON.parse(fs.readFileSync(file));
  }
  async function enroll(role, c) {
    await node("admin-enroll-" + role, [
      "scripts/admin.js",
      "enroll",
      String(role),
      c.leaf,
    ]);
  }
  async function authenticate() {
    await page
      .getByRole("button", { name: "Authenticate approved role" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Encrypted synthetic records" })
    ).toBeVisible({ timeout: 120000 });
  }
  const doctor = await credential(0);
  // Browser refuses unapproved membership, and no self-enrollment request is possible.
  await page
    .getByRole("button", { name: "Authenticate approved role" })
    .click();
  await expect(page.getByRole("status")).toContainText("No approved members", {
    timeout: 15000,
  });
  evidence.checks.push("unapproved browser credential rejected");
  await enroll(0, doctor);
  await authenticate();
  evidence.checks.push(
    "real browser-worker proof and wallet-signature authentication"
  );
  async function register(type, abo, urgency) {
    await page.getByRole("button", { name: "records", exact: true }).click();
    await page
      .getByLabel("Record type", { exact: true })
      .selectOption(String(type));
    await page.getByLabel("ABO group", { exact: true }).selectOption(abo);
    await page
      .getByLabel("Recipient urgency", { exact: true })
      .selectOption(String(urgency));
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/records") && r.request().method() === "POST"
    );
    await page
      .getByRole("button", { name: "Encrypt and register record" })
      .click();
    const prepared = await (await response).json();
    if (!prepared.id)
      throw Error("Record preparation failed: " + JSON.stringify(prepared));
    await expect(page.getByRole("status")).toContainText(
      "Encrypted record registered",
      { timeout: 30000 }
    );
    return prepared.id;
  }
  const donor = await register(0, "O", 0),
    recipient = await register(1, "A", 2);
  evidence.checks.push(
    "browser registration, encrypted Kubo upload and opaque on-chain anchors"
  );
  async function evaluate() {
    await page.getByRole("button", { name: "matching", exact: true }).click();
    await page.getByLabel("Donor", { exact: true }).selectOption(donor);
    await page.getByLabel("Recipient", { exact: true }).selectOption(recipient);
    await page
      .getByRole("button", { name: "Evaluate pair", exact: true })
      .click();
    await expect(page.getByTestId("match-result")).toHaveText(
      "1000 synthetic ranking points",
      { timeout: 30000 }
    );
  }
  await evaluate();
  evidence.checks.push("BFV matching over retrieved encrypted records");
  await stop(apiProcess);
  apiProcess = launch("api-restart", process.execPath, ["server/index.js"]);
  await ready(
    "Restarted API",
    async () => (await fetch("http://127.0.0.1:13001/api/status")).ok
  );
  await evaluate();
  evidence.checks.push(
    "API session, BFV secret and record keys survive process restart"
  );
  await page
    .getByRole("button", { name: "Rank batch (up to 10 x 10)" })
    .click();
  await expect(page.getByText(/Batch: completed/)).toBeVisible({
    timeout: 30000,
  });
  evidence.checks.push("authorized batch ranking");
  // Change wallet; app must erase authorization state.
  accountIndex = 2;
  await page.evaluate(
    (address) => window.ethereum.emitTestEvent("accountsChanged", [address]),
    wallet().address
  );
  await page.getByRole("button", { name: "access", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  const surgeon = await credential(5);
  await enroll(5, surgeon);
  await authenticate();
  await page.getByRole("button", { name: "revocation", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh records", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Revoke " + donor.slice(0, 10), exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Record deactivated", {
    timeout: 30000,
  });
  await ready("Local cleanup", async () => {
    await page
      .getByRole("button", {
        name: "Check cleanup " + donor.slice(0, 10),
        exact: true,
      })
      .click();
    return (
      await page.locator("article").filter({ hasText: donor }).innerText()
    ).includes("completed locally");
  });
  evidence.checks.push(
    "browser surgeon revocation and real local IPFS cleanup"
  );
  // Recipient revocation occurs while API is stopped; catch-up must complete after recovery.
  await stop(apiProcess);
  const deployment = JSON.parse(
      fs.readFileSync(path.join(root, "deployments/e2e.json"))
    ),
    abi = JSON.parse(
      fs.readFileSync(path.join(root, "src/generated/abis.json"))
    );
  const surgeonSigner = await provider.getSigner(2),
    lifecycle = new ethers.Contract(
      deployment.LifecycleManager,
      abi.LifecycleManager,
      surgeonSigner
    );
  await (await lifecycle.requestRevocation(recipient)).wait();
  await (await lifecycle.executeRevocation(recipient)).wait();
  apiProcess = launch("api-catchup", process.execPath, ["server/index.js"]);
  await ready(
    "Recovered API",
    async () => (await fetch("http://127.0.0.1:13001/api/status")).ok
  );
  await ready("Missed-event cleanup", async () => {
    await page
      .getByRole("button", {
        name: "Check cleanup " + recipient.slice(0, 10),
        exact: true,
      })
      .click();
    return (
      await page.locator("article").filter({ hasText: recipient }).innerText()
    ).includes("completed locally");
  });
  evidence.checks.push(
    "recipient revocation while service offline recovered from event cursor"
  );
  accountIndex = 3;
  await page.evaluate(
    (address) => window.ethereum.emitTestEvent("accountsChanged", [address]),
    wallet().address
  );
  await page.getByRole("button", { name: "access", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  const transporter = await credential(4);
  await enroll(4, transporter);
  await page
    .getByRole("button", { name: "Authenticate approved role" })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Approved role authenticated.",
    { timeout: 120000 }
  );
  await page.getByRole("button", { name: "records", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Encrypt and register record" })
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Refresh records", exact: true })
  ).toBeDisabled();
  evidence.checks.push(
    "approved Transporter authenticates without clinical access"
  );
  const missingDatabase = launch(
    "api-missing-database",
    process.execPath,
    ["server/index.js"],
    { DATA_DIR: path.join(runDir, "missing-database"), PORT: "13002" }
  );
  const missingExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Missing-database startup check timed out")),
      30000
    );
    missingDatabase.once("error", reject);
    missingDatabase.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (
    missingExit !== 1 ||
    !fs
      .readFileSync(path.join(runDir, "api-missing-database.log"), "utf8")
      .includes("BFV key metadata is missing")
  )
    throw Error(
      "Existing records must prevent startup with missing BFV key metadata"
    );
  evidence.checks.push(
    "missing database fails closed when on-chain records exist"
  );
  for (const secret of [doctor.secret, surgeon.secret, transporter.secret])
    if (requests.some((r) => r.body.includes(secret)))
      throw Error("Credential secret leaked to API");
  evidence.checks.push("no credential secret transmitted to API");
  if (errors.length) throw Error("Browser errors: " + errors.join("; "));
  await page.screenshot({
    path: path.join(runDir, "completed.png"),
    fullPage: true,
  });
  evidence.completedAt = new Date().toISOString();
  evidence.passed = true;
  evidence.browser = await browser.version();
  fs.writeFileSync(
    path.join(runDir, "evidence.json"),
    JSON.stringify(evidence, null, 2)
  );
  console.log(
    "Live acceptance demo passed:",
    evidence.checks.length,
    "checks. Evidence:",
    path.join(runDir, "evidence.json")
  );
}
main()
  .catch(async (e) => {
    console.error(e.stack);
    console.error("Logs:", runDir);
    process.exitCode = 1;
    if (lastPage) {
      await lastPage
        .screenshot({ path: path.join(runDir, "failure.png"), fullPage: true })
        .catch(() => {});
      fs.writeFileSync(
        path.join(runDir, "failure.html"),
        await lastPage.content().catch(() => "")
      );
    }
  })
  .finally(async () => {
    await browser?.close();
    provider?.destroy();
    for (const child of [...children].reverse()) await stop(child);
  });
