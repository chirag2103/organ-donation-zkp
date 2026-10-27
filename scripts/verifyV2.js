"use strict";
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const root = path.resolve(__dirname, ".."), out = path.join(root, "paper/evaluation-v2");
fs.mkdirSync(out, { recursive: true });
const checks = [
  ["compile", ["node_modules/hardhat/internal/cli/cli.js", "compile"]],
  ["abis", ["scripts/exportAbis.js"]],
  ["source", ["scripts/checkSource.js"]],
  ["frontend", ["node_modules/vite/bin/vite.js", "build", "--config", "vite.config.mjs"]],
  ["tests", ["node_modules/hardhat/internal/cli/cli.js", "test"]],
];
async function main() {
  const evidence = { startedAt: new Date().toISOString(), node: process.version, checks: [] };
  for (const [name, args] of checks) {
    const log = path.join(out, "validation-" + name + ".log"); let stdout = "";
    console.log("Validation:", name);
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, windowsHide: true });
    const stream = fs.createWriteStream(log);
    child.stdout.on("data", data => { stdout += data.toString(); stream.write(data); process.stdout.write(data); });
    child.stderr.on("data", data => { stream.write(data); process.stderr.write(data); });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    await new Promise(resolve => stream.end(resolve));
    evidence.checks.push({ name, passed: code === 0 });
    if (name === "tests") { evidence.testsPassed = Number(/(\d+) passing/.exec(stdout)?.[1] || 0); evidence.testsSkipped = Number(/(\d+) pending/.exec(stdout)?.[1] || 0); }
    if (code !== 0) throw Error(name + " failed; inspect " + log);
  }
  const files = ["package-lock.json", "src/App.jsx", "src/prover.worker.js", "shared/protocol.mjs",
    ...fs.readdirSync(path.join(root, "server")).filter(x => x.endsWith(".js")).map(x => "server/" + x),
    ...fs.readdirSync(path.join(root, "contracts")).filter(x => x.endsWith(".sol")).map(x => "contracts/" + x)];
  evidence.sourceHashes = Object.fromEntries(files.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")]));
  evidence.completedAt = new Date().toISOString(); evidence.passed = true;
  fs.writeFileSync(path.join(out, "validation.json"), JSON.stringify(evidence, null, 2));
  const liveFiles = fs.readdirSync(path.join(root, "runtime")).filter(x => x.startsWith("e2e-")).sort().reverse();
  const live = liveFiles.map(x => path.join(root, "runtime", x, "evidence.json")).find(x => fs.existsSync(x));
  if (process.env.RUN_LIVE_E2E === "1" && live) fs.copyFileSync(live, path.join(out, "browser-acceptance.json"));
  console.log("Validation evidence saved;", evidence.testsPassed, "passing,", evidence.testsSkipped, "skipped.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
