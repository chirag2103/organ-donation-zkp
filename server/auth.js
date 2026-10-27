"use strict";
const crypto = require("crypto");
const { ethers } = require("ethers");
const { digest } = require("./crypto");
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
class Auth {
  constructor(store, chain, origin, clock = () => Date.now()) {
    Object.assign(this, { store, chain, origin, clock });
  }
  async challenge(address) {
    if (!ethers.isAddress(address)) throw new ApiError(400, "Invalid wallet");
    address = ethers.getAddress(address);
    const now = this.clock(),
      nonce = crypto.randomBytes(24).toString("hex"),
      expiresAt = now + 300000;
    const message = [
      "Organ Donation Research v2",
      `Origin: ${this.origin}`,
      `Chain: ${this.chain.deployment.chainId}`,
      `Issuer: ${this.chain.deployment.PFEKeyIssuer}`,
      `Wallet: ${address}`,
      `Nonce: ${nonce}`,
      `Expires: ${expiresAt}`,
    ].join("\n");
    this.store.put("challenges", nonce, { address, message, expiresAt });
    return { nonce, message, expiresAt };
  }
  async session(nonce, signature) {
    const challenge = this.store.transaction(() => {
      const c = this.store.get("challenges", nonce || "");
      if (!c || c.expiresAt <= this.clock())
        throw new ApiError(401, "Challenge expired or consumed");
      this.store.remove("challenges", nonce);
      return c;
    });
    let address;
    try {
      address = ethers.verifyMessage(challenge.message, signature);
    } catch {
      throw new ApiError(401, "Invalid signature");
    }
    if (address !== challenge.address)
      throw new ApiError(401, "Wallet mismatch");
    const authorization = await this.chain.authorization(address);
    if (!authorization.valid)
      throw new ApiError(403, "Approved on-chain authorization required");
    const token = crypto.randomBytes(32).toString("hex");
    const session = {
      address,
      roleId: authorization.roleId,
      rootVersion: authorization.rootVersion,
      expiresAt: Math.min(
        authorization.expiresAt * 1000,
        this.clock() + 4 * 3600000
      ),
    };
    this.store.put("sessions", digest(token), session);
    return { token, ...session };
  }
  async authorize(token, bit) {
    const s =
      typeof token === "string"
        ? this.store.get("sessions", digest(token))
        : null;
    if (!s || s.expiresAt <= this.clock())
      throw new ApiError(401, "Session expired or missing");
    const a = await this.chain.authorization(s.address);
    if (!a.valid || a.roleId !== s.roleId || a.rootVersion !== s.rootVersion)
      throw new ApiError(403, "Session revoked or membership changed");
    const masks = [7, 7, 3, 1, 0, 9];
    if (bit !== undefined && !(masks[s.roleId] & (1 << bit)))
      throw new ApiError(403, "Role permission denied");
    return s;
  }
}
module.exports = { Auth, ApiError };
