"use strict";
const SEAL = require("node-seal");
const { seal: wrap, open } = require("./crypto");

class BfvService {
  async init(store, wrappingKey) {
    this.seal = await SEAL();
    const s = this.seal,
      p = s.EncryptionParameters(s.SchemeType.bfv);
    p.setPolyModulusDegree(4096);
    p.setCoeffModulus(s.CoeffModulus.BFVDefault(4096, s.SecurityLevel.tc128));
    p.setPlainModulus(s.PlainModulus.Batching(4096, 20));
    this.context = s.Context(p, true, s.SecurityLevel.tc128);
    if (!this.context.parametersSet()) throw Error("Invalid BFV parameters");
    let saved = store.get("keys", "bfv-v1");
    this.secret = s.SecretKey();
    if (saved)
      this.secret.load(
        this.context,
        open(saved.envelope, wrappingKey, "bfv-v1").toString()
      );
    else {
      if (store.list("records").length)
        throw Error("BFV key missing while records exist; restore backup");
      const generator = s.KeyGenerator(this.context);
      this.secret.delete();
      this.secret = generator.secretKey();
      generator.delete();
      store.put("keys", "bfv-v1", {
        version: 1,
        envelope: wrap(this.secret.save(), wrappingKey, "bfv-v1"),
      });
    }
    const generator = s.KeyGenerator(this.context, this.secret);
    this.publicKey = generator.createPublicKey();
    this.relin = generator.createRelinKeys();
    generator.delete();
    this.encoder = s.BatchEncoder(this.context);
    this.encryptor = s.Encryptor(this.context, this.publicKey);
    this.decryptor = s.Decryptor(this.context, this.secret);
    this.evaluator = s.Evaluator(this.context);
    p.delete();
    return this;
  }
  plain(n) {
    const p = this.seal.PlainText();
    this.encoder.encode(
      new BigInt64Array(this.encoder.slotCount).fill(BigInt(n)),
      p
    );
    return p;
  }
  encrypt(n) {
    const p = this.plain(n),
      c = this.seal.CipherText();
    try {
      this.encryptor.encrypt(p, c);
      return c.save();
    } finally {
      p.delete();
      c.delete();
    }
  }
  load(value) {
    const c = this.seal.CipherText();
    c.load(this.context, value);
    return c;
  }
  encryptAttributes(a) {
    return {
      version: 1,
      a: this.encrypt(a.abo.includes("A") ? 1 : 0),
      b: this.encrypt(a.abo.includes("B") ? 1 : 0),
      features: a.features.map((x) => this.encrypt(x)),
      urgency: this.encrypt(a.urgency),
    };
  }
  evaluate(d, r) {
    if (d.version !== 1 || r.version !== 1)
      throw Error("Unsupported BFV key version");
    const owned = [],
      ev = this.evaluator;
    const load = (x) => {
      const c = this.load(x);
      owned.push(c);
      return c;
    };
    const ct = () => {
      const c = this.seal.CipherText();
      owned.push(c);
      return c;
    };
    const plain = (n) => {
      const p = this.plain(n);
      owned.push(p);
      return p;
    };
    try {
      const incompat = [];
      for (const key of ["a", "b"]) {
        const neg = ct(),
          product = ct();
        ev.negate(load(r[key]), neg);
        ev.addPlain(neg, plain(1), neg);
        ev.multiply(load(d[key]), neg, product);
        ev.relinearize(product, this.relin, product);
        incompat.push(product);
      }
      const eligibility = ct();
      ev.add(incompat[0], incompat[1], eligibility);
      const mismatches = [];
      for (let i = 0; i < 6; i++) {
        const diff = ct(),
          sq = ct();
        ev.sub(load(d.features[i]), load(r.features[i]), diff);
        ev.multiply(diff, diff, sq);
        ev.relinearize(sq, this.relin, sq);
        mismatches.push(sq);
      }
      const total = ct();
      ev.add(mismatches[0], mismatches[1], total);
      for (let i = 2; i < 6; i++) ev.add(total, mismatches[i], total);
      ev.multiplyPlain(total, plain(700), total);
      ev.negate(total, total);
      ev.addPlain(total, plain(4200), total);
      const urgency = ct();
      ev.multiplyPlain(load(r.urgency), plain(900), urgency);
      ev.add(total, urgency, total);
      return { eligibility: eligibility.save(), numerator: total.save() };
    } finally {
      owned.forEach((x) => x.delete());
    }
  }
  decrypt(value) {
    const c = this.load(value),
      p = this.seal.PlainText();
    try {
      const noise = this.decryptor.invariantNoiseBudget(c);
      if (noise <= 0) throw Error("BFV noise budget exhausted");
      this.decryptor.decrypt(c, p);
      return { value: Number(this.encoder.decode(p, false)[0]), noise };
    } finally {
      c.delete();
      p.delete();
    }
  }
  release(evaluated) {
    const eligibility = this.decrypt(evaluated.eligibility);
    if (eligibility.value !== 0) return { eligible: false, score: null };
    const result = this.decrypt(evaluated.numerator);
    if (result.value < 0 || result.value > 6000)
      throw Error("BFV result outside policy bounds");
    return { eligible: true, score: Math.round(result.value / 6) };
  }
  close() {
    for (const name of [
      "encoder",
      "encryptor",
      "decryptor",
      "evaluator",
      "relin",
      "publicKey",
      "secret",
      "context",
    ])
      this[name]?.delete();
  }
}
module.exports = { BfvService };
