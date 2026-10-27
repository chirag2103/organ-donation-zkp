"use strict";
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
if (fs.existsSync(path.join(root, ".env")))
  process.loadEnvFile(path.join(root, ".env"));
function config(overrides = {}) {
  const network = process.env.NETWORK || "localhost";
  const result = {
    root,
    network,
    port: Number(process.env.PORT || 3001),
    rpcUrl: process.env.RPC_URL || "http://127.0.0.1:8545",
    origin: process.env.APP_ORIGIN || "http://localhost:5173",
    dataDir: path.resolve(
      process.env.DATA_DIR || path.join(root, "runtime", network)
    ),
    wrappingKey: process.env.WRAPPING_KEY,
    ipfsUrl: process.env.IPFS_API_URL || "http://127.0.0.1:5001",
    confirmations: Number(
      process.env.CONFIRMATIONS || (network === "localhost" ? 1 : 6)
    ),
    ...overrides,
  };
  if (!Number.isInteger(result.confirmations) || result.confirmations < 1)
    throw Error("CONFIRMATIONS must be a positive integer");
  return result;
}
module.exports = { config };
