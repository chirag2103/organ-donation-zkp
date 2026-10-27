"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const filename = path.join(__dirname, "../.env");
if (fs.existsSync(filename)) console.log("Existing .env preserved");
else {
  const text = fs
    .readFileSync(path.join(__dirname, "../.env.example"), "utf8")
    .replace(
      "WRAPPING_KEY=",
      "WRAPPING_KEY=" + crypto.randomBytes(32).toString("hex")
    );
  fs.writeFileSync(filename, text, { mode: 0o600, flag: "wx" });
  console.log(
    "Local .env created with a random wrapping key; keep it private and back it up securely."
  );
}
