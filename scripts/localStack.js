"use strict";
const fs = require("fs"),
  path = require("path"),
  { spawn, execFileSync } = require("child_process");
const root = path.resolve(__dirname, ".."),
  dir = path.join(root, "runtime/local-stack");
fs.mkdirSync(dir, { recursive: true });
require("./initLocal");
const { config } = require("../server/config");
const cfg = config();
const env = {
  ...process.env,
  NETWORK: "localhost",
  RPC_URL: "http://127.0.0.1:8545",
  PORT: String(cfg.port),
  VITE_API_URL: `http://127.0.0.1:${cfg.port}`,
  APP_ORIGIN: "http://localhost:5173",
  IPFS_API_URL: "http://127.0.0.1:5001",
  CONFIRMATIONS: "1",
  IPFS_PATH: path.join(dir, "ipfs"),
};
delete env.ADMIN_PRIVATE_KEY;
delete env.DEPLOYER_PRIVATE_KEY;
const children = [];
function launch(name, executable, args) {
  const log = fs.openSync(path.join(dir, name + ".log"), "a");
  const child = spawn(executable, args, {
    cwd: root,
    env,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  children.push(child);
  try {
    child.createdTicks = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${child.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();
  } catch {
    child.createdTicks = null;
  }
  fs.writeFileSync(
    path.join(dir, "processes.json"),
    JSON.stringify(
      children.map((c) => ({
        pid: c.pid,
        createdTicks: c.createdTicks,
      }))
    )
  );
  child.on("error", (e) => console.error(name, e.message));
  return child;
}
async function once(name, exe, args) {
  const c = launch(name, exe, args);
  await new Promise((resolve, reject) => {
    c.once("error", reject);
    c.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error(name + " failed; inspect runtime/local-stack logs"))
    );
  });
}
async function ready(fn) {
  for (let i = 0; i < 120; i++) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Service readiness timed out");
}
async function unused(port) {
  const net = require("net");
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", (error) =>
      reject(
        Error(
          error.code === "EADDRINUSE"
            ? "Port " +
                port +
                " already occupied; stop the existing stack first"
            : "Cannot bind port " + port + ": " + error.message
        )
      )
    );
    s.listen(port, "127.0.0.1", () => s.close(resolve));
  });
}
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const c of [...children].reverse()) if (c.exitCode === null) c.kill();
}
async function main() {
  for (const port of [8545, 5001, 18080, 5173, cfg.port]) await unused(port);
  const ipfs =
    env.IPFS_BINARY ||
    execFileSync("where.exe", ["ipfs"], { encoding: "utf8", windowsHide: true })
      .trim()
      .split(/\r?\n/)[0];
  if (!fs.existsSync(path.join(env.IPFS_PATH, "config")))
    await once("ipfs-init", ipfs, ["init", "--profile=test"]);
  await once("ipfs-config-api", ipfs, [
    "config",
    "Addresses.API",
    "/ip4/127.0.0.1/tcp/5001",
  ]);
  await once("ipfs-config-gateway", ipfs, [
    "config",
    "Addresses.Gateway",
    "/ip4/127.0.0.1/tcp/18080",
  ]);
  launch("hardhat", process.execPath, [
    path.join(root, "node_modules/hardhat/internal/cli/cli.js"),
    "node",
    "--hostname",
    "127.0.0.1",
  ]);
  await ready(async () => {
    const r = await fetch("http://127.0.0.1:8545", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
    });
    return r.ok;
  });
  await once("deploy", process.execPath, [
    path.join(root, "node_modules/hardhat/internal/cli/cli.js"),
    "run",
    path.join(root, "scripts/deploy.js"),
    "--network",
    "localhost",
  ]);
  launch("ipfs", ipfs, ["daemon", "--offline"]);
  await ready(
    async () =>
      (
        await fetch("http://127.0.0.1:5001/api/v0/version", { method: "POST" })
      ).ok
  );
  launch("api", process.execPath, [path.join(root, "server/index.js")]);
  await ready(
    async () => (await fetch(`http://127.0.0.1:${cfg.port}/api/status`)).ok
  );
  launch("frontend", process.execPath, [
    path.join(root, "node_modules/vite/bin/vite.js"),
    "--config",
    path.join(root, "vite.config.mjs"),
    "--strictPort",
  ]);
  await ready(async () => (await fetch("http://127.0.0.1:5173")).ok);
  console.log(
    "Ready: http://localhost:5173. Logs: runtime/local-stack. Ctrl+C stops only this stack."
  );
  console.log(
    "Fresh chain: clear stale wallet nonce/activity data if needed. Approve public membership leaves using npm run admin."
  );
}
process.on("SIGINT", () => close().then(() => process.exit(0)));
process.on("SIGTERM", () => close().then(() => process.exit(0)));
main().catch((e) => {
  console.error(e.message);
  close().then(() => process.exit(1));
});
