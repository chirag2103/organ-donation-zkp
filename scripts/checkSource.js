"use strict";
const fs = require("fs"),
  path = require("path"),
  { spawnSync } = require("child_process");
const directories = ["server", "scripts", "shared", "src", "test/v2"];
let failed = false;
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? e.name === "public"
          ? []
          : walk(path.join(dir, e.name))
        : [path.join(dir, e.name)]
    );
}
for (const dir of directories)
  for (const name of walk(dir)) {
    if (!/\.(js|jsx|mjs|json|css)$/.test(name)) continue;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(name));
    } catch {
      console.error("Invalid UTF-8:", name);
      failed = true;
    }
    if (/\.(js|mjs)$/.test(name) && !name.startsWith("src")) {
      const result = spawnSync(process.execPath, ["--check", name], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.status !== 0) {
        console.error(result.stderr);
        failed = true;
      }
    }
  }
process.exitCode = failed ? 1 : 0;
if (!failed) console.log("Source syntax and UTF-8 checks passed");
