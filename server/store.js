"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

class Store {
  constructor(filename) {
    if (filename !== ":memory:")
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;"
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS documents (
      collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(collection,id));`);
  }
  get(collection, id) {
    const row = this.db
      .prepare("SELECT value FROM documents WHERE collection=? AND id=?")
      .get(collection, id);
    return row ? JSON.parse(row.value) : null;
  }
  put(collection, id, value) {
    this.db
      .prepare(
        "INSERT INTO documents VALUES (?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value"
      )
      .run(collection, id, JSON.stringify(value));
    return value;
  }
  list(collection) {
    return this.db
      .prepare("SELECT id,value FROM documents WHERE collection=? ORDER BY id")
      .all(collection)
      .map((row) => ({ ...JSON.parse(row.value), id: row.id }));
  }
  remove(collection, id) {
    this.db
      .prepare("DELETE FROM documents WHERE collection=? AND id=?")
      .run(collection, id);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
module.exports = { Store };
