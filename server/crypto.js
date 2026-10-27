"use strict";
const crypto = require("crypto");
function wrappingKey(hex) {
  if (!/^[a-f0-9]{64}$/i.test(hex || ""))
    throw Error("WRAPPING_KEY must be 32 random bytes in hex");
  return Buffer.from(hex, "hex");
}
function seal(data, key, aad) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(data)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
function open(value, key, aad) {
  const data = Buffer.from(value, "base64");
  if (data.length < 28) throw Error("Invalid encrypted envelope");
  const cipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    data.subarray(0, 12)
  );
  cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
}
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
module.exports = { wrappingKey, seal, open, digest };
