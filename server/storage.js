"use strict";
class IpfsStorage {
  async init(url) {
    this.url = url.replace(/\/$/, "");
    return this;
  }
  async request(method, params = {}, body) {
    const query = new URLSearchParams(params);
    const response = await fetch(this.url + "/api/v0/" + method + "?" + query, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw Error(
        "Kubo operation failed: " + (await response.text()).slice(0, 300)
      );
    return response;
  }
  async put(data) {
    const form = new FormData();
    form.append("file", new Blob([data]), "encrypted-record");
    const response = await this.request(
      "add",
      { pin: "true", "cid-version": "1" },
      form
    );
    const result = JSON.parse(
      (await response.text()).trim().split("\n").at(-1)
    );
    if (!result.Hash) throw Error("Kubo did not return CID");
    return result.Hash;
  }
  async get(cid) {
    const parts = [];
    let size = 0;
    const response = await this.request("cat", { arg: cid });
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw Error("Record exceeds size limit");
      parts.push(Buffer.from(chunk));
    }
    return Buffer.concat(parts);
  }
  async remove(cid) {
    try {
      await this.request("pin/rm", { arg: cid });
    } catch (e) {
      if (!/not pinned/i.test(e.message)) throw e;
    }
    // GC errors are failures, never a successful erasure claim.
    const response = await this.request("repo/gc");
    const lines = (await response.text()).trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const result = JSON.parse(line);
      if (result.Error) throw Error(String(result.Error));
    }
  }
  async health() {
    try {
      return Boolean((await (await this.request("version")).json()).Version);
    } catch {
      return false;
    }
  }
}
module.exports = { IpfsStorage };
