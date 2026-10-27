"use strict";
const fs = require("fs"),
  path = require("path");
const names = [
  "RoleRegistry",
  "PFEKeyIssuer",
  "OrganRegistry",
  "LifecycleManager",
];
const abis = {};
for (const name of names)
  abis[name] = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "../artifacts/contracts",
        name + ".sol",
        name + ".json"
      )
    )
  ).abi;
fs.mkdirSync(path.join(__dirname, "../src/generated"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "../src/generated/abis.json"),
  JSON.stringify(abis, null, 2)
);
console.log("Exported frontend ABIs from compiled contracts");
