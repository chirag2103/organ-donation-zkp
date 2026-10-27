"use strict";
class RevocationWorker {
  constructor({
    store,
    chain,
    storage,
    confirmations = 1,
    clock = () => Date.now(),
  }) {
    Object.assign(this, { store, chain, storage, confirmations, clock });
    this.running = false;
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const head = await this.chain.head(),
        safe = head - this.confirmations + 1;
      let cursor = this.store.get("worker", "cursor");
      if (cursor) {
        const previous = await this.chain.block(cursor.block);
        if (!previous || previous.hash !== cursor.hash) {
          // Reconcile from deployment; key deletion is irreversible, so alert on deep reorg.
          this.store.put("worker", "reorg", {
            at: this.clock(),
            message: "Confirmed history changed; audit prior key deletion",
          });
          throw Error(
            "Confirmed-chain reorganization: cleanup halted for administrator audit"
          );
        }
      }
      const start = cursor
        ? cursor.block + 1
        : this.chain.deployment.deployedBlock;
      const end = Math.min(safe, start + 499);
      if (end >= start) {
        const events = await this.chain.events(start, end);
        const endBlock = await this.chain.block(end);
        this.store.transaction(() => {
          for (const event of events) {
            const current = this.store.get("revocations", event.id) || {
              attempts: 0,
            };
            if (current.state === "completed locally") continue;
            const executed = event.kind === "RevocationExecuted";
            this.store.put("revocations", event.id, {
              ...current,
              state: executed ? "cleanup pending" : "requested",
              block: event.blockNumber,
              blockHash: event.blockHash,
              logIndex: event.index,
              nextAttempt: 0,
            });
          }
          this.store.put("worker", "cursor", {
            block: end,
            hash: endBlock.hash,
          });
        });
      }
      for (const job of this.store.list("revocations")) {
        if (
          !["cleanup pending", "failed", "deactivated"].includes(job.state) ||
          job.nextAttempt > this.clock()
        )
          continue;
        try {
          const canonical = await this.chain.record(job.id);
          if (canonical.active) throw Error("Canonical record is still active");
          const record = this.store.get("records", job.id);
          if (!record) throw Error("Canonical off-chain record missing");
          // Delete the service-held record key before attempting external cleanup.
          this.store.transaction(() => {
            delete record.wrappedKey;
            record.state = "deactivated";
            this.store.put("records", job.id, record);
            this.store.put("revocations", job.id, {
              ...job,
              state: "cleanup pending",
            });
          });
          await this.storage.remove(record.cid);
          this.store.put("revocations", job.id, {
            ...job,
            state: "completed locally",
            completedAt: this.clock(),
            error: null,
          });
        } catch (e) {
          const attempts = job.attempts + 1;
          this.store.put("revocations", job.id, {
            ...job,
            state: "failed",
            attempts,
            error: "Cleanup failed; inspect local infrastructure",
            nextAttempt:
              this.clock() +
              Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12)),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
module.exports = { RevocationWorker };
