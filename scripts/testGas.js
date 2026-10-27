"use strict";
const { spawnSync } = require("child_process");
const path = require("path");
const result = spawnSync(
  process.execPath,
  [path.join(__dirname, "../node_modules/hardhat/internal/cli/cli.js"), "test"],
  {
    env: { ...process.env, REPORT_GAS: "true" },
    stdio: "inherit",
    windowsHide: true,
  }
);
process.exitCode = result.status ?? 1;
