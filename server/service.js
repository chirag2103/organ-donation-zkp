"use strict";
const crypto = require("crypto");
const { ethers } = require("ethers");
const { seal, open } = require("./crypto");
const { ApiError } = require("./auth");
const validId = (id) => typeof id === "string" && /^0x[0-9a-f]{64}$/i.test(id);
class RecordService {
  constructor({ store, chain, storage, bfv, wrappingKey, protocol }) {
    Object.assign(this, { store, chain, storage, bfv, wrappingKey, protocol });
  }
  async prepare(owner, entityType, attributes) {
    if (![0, 1].includes(entityType))
      throw new ApiError(400, "entityType must be 0 donor or 1 recipient");
    let a;
    try {
      a = this.protocol.validateAttributes(attributes);
    } catch (e) {
      throw new ApiError(400, e.message);
    }
    const id = "0x" + crypto.randomBytes(32).toString("hex"),
      key = crypto.randomBytes(32);
    const encrypted = this.bfv.encryptAttributes(a);
    const envelope = seal(JSON.stringify(encrypted), key, "record:" + id);
    const cid = await this.storage.put(Buffer.from(envelope));
    const anchor = ethers.keccak256(ethers.toUtf8Bytes(cid));
    const record = {
      owner,
      entityType,
      cid,
      anchor,
      keyVersion: 1,
      wrappedKey: seal(key, this.wrappingKey, "key:" + id),
      state: "pending registration",
      createdAt: Date.now(),
    };
    key.fill(0);
    this.store.put("records", id, record);
    return { id, anchor, entityType, state: record.state };
  }
  async canonical(id) {
    if (!validId(id)) throw new ApiError(400, "Invalid record ID");
    const r = this.store.get("records", id);
    if (!r) throw new ApiError(404, "Record not found");
    const c = await this.chain.record(id);
    if (
      !c.active ||
      !r.wrappedKey ||
      c.anchor !== r.anchor ||
      c.entityType !== r.entityType ||
      c.registeredBy.toLowerCase() !== r.owner.toLowerCase()
    )
      throw new ApiError(409, "Record inactive, unconfirmed or inconsistent");
    return r;
  }
  async confirm(id, owner) {
    const r = await this.canonical(id);
    if (r.owner !== owner) throw new ApiError(403, "Record owner mismatch");
    r.state = "active";
    this.store.put("records", id, r);
    return { id, state: r.state };
  }
  async bundle(id, record) {
    const key = open(record.wrappedKey, this.wrappingKey, "key:" + id);
    try {
      return JSON.parse(
        open(
          (await this.storage.get(record.cid)).toString(),
          key,
          "record:" + id
        )
      );
    } finally {
      key.fill(0);
    }
  }
  async evaluate(donorId, recipientId, bundleCache) {
    const d = await this.canonical(donorId),
      r = await this.canonical(recipientId);
    if (d.entityType !== 0 || r.entityType !== 1)
      throw new ApiError(400, "Expected donor and recipient IDs");
    const load = (id, record) => {
      if (!bundleCache) return this.bundle(id, record);
      const key = id + ":" + record.anchor;
      if (!bundleCache.has(key)) bundleCache.set(key, this.bundle(id, record));
      return bundleCache.get(key);
    };
    const [db, rb] = await Promise.all([
      load(donorId, d),
      load(recipientId, r),
    ]);
    const evaluated = this.bfv.evaluate(db, rb);
    await this.canonical(donorId);
    await this.canonical(recipientId);
    return {
      donorId,
      recipientId,
      ...this.bfv.release(evaluated),
      policy: "synthetic-v2",
    };
  }
}
module.exports = { RecordService, validId };
