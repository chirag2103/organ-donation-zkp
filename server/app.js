"use strict";
const express = require("express"),
  helmet = require("helmet"),
  cors = require("cors"),
  rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { ApiError } = require("./auth");
const { validId } = require("./service");
function createApp({
  config,
  store,
  chain,
  auth,
  records,
  storage,
  protocol,
  manifest,
  limits = {},
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.origin }));
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 900000,
      limit: limits.requests || 1000,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    })
  );
  const heavy = rateLimit({
    windowMs: 900000,
    limit: limits.expensiveRequests || 100,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const route = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  const bearer = (req) =>
    /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization || "")?.[1];
  // Middleware must call next explicitly; async route helpers above only end endpoint responses.
  const guard = (bit) => (req, res, next) =>
    auth.authorize(bearer(req), bit).then((s) => {
      req.actor = s;
      next();
    }, next);
  const exact = (body, keys) => {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !keys.includes(k))
    )
      throw new ApiError(400, "Unexpected request fields");
  };
  app.get(
    "/api/status",
    route(async (req, res) =>
      res.json({
        protocolVersion: 2,
        ipfs: await storage.health(),
        blockchain: await chain.validate().then(
          () => true,
          () => false
        ),
        seal: true,
        network: config.network,
        worker: store.get("worker", "reorg") ? "audit required" : "running",
      })
    )
  );
  app.get("/api/config", (req, res) =>
    res.json({
      deployment: chain.deployment,
      manifest,
      roles: protocol.ROLES,
      permissions: protocol.MASKS,
    })
  );
  app.post(
    "/api/auth/challenge",
    heavy,
    route(async (req, res) => {
      exact(req.body, ["address"]);
      res.json(await auth.challenge(req.body.address));
    })
  );
  app.post(
    "/api/auth/session",
    heavy,
    route(async (req, res) => {
      exact(req.body, ["nonce", "signature"]);
      res.json(await auth.session(req.body.nonce, req.body.signature));
    })
  );
  app.delete("/api/auth/session", guard(), (req, res) => {
    store.remove("sessions", require("./crypto").digest(bearer(req)));
    res.json({ success: true });
  });
  app.get(
    "/api/roles/:roleId/membership",
    route(async (req, res) => {
      const roleId = Number(req.params.roleId);
      if (!Number.isInteger(roleId) || roleId < 0 || roleId > 5)
        throw new ApiError(400, "Invalid role");
      const member = store.get("memberships", String(roleId));
      if (!member) throw new ApiError(404, "No approved members for role");
      const root = await chain.roles.roots(roleId),
        version = await chain.roles.versions(roleId);
      if (root.toString() !== member.root)
        throw new ApiError(
          503,
          "Enrollment publication incomplete; administrator must reconcile"
        );
      res.json({
        roleId,
        leaves: member.leaves,
        root: member.root,
        rootVersion: Number(version),
      });
    })
  );
  app.get(
    "/api/records",
    guard(),
    route(async (req, res) => {
      if (!(protocol.MASKS[req.actor.roleId] & 7))
        throw new ApiError(403, "Records forbidden");
      const result = [];
      for (const r of store.list("records")) {
        const c = await chain.record(r.id);
        if (c.timestamp && c.anchor === r.anchor)
          result.push({
            id: r.id,
            entityType: r.entityType,
            active: c.active,
            owner: r.owner,
            revocation:
              store.get("revocations", r.id)?.state ||
              (c.active ? "active" : "deactivated"),
          });
      }
      res.json(result);
    })
  );
  app.post(
    "/api/records",
    heavy,
    guard(),
    route(async (req, res) => {
      exact(req.body, ["entityType", "attributes"]);
      const { entityType, attributes } = req.body;
      if (![0, 1].includes(entityType))
        throw new ApiError(400, "Invalid entity type");
      await auth.authorize(bearer(req), entityType === 0 ? 1 : 2);
      if (
        store
          .list("records")
          .filter(
            (r) =>
              r.owner === req.actor.address &&
              r.state === "pending registration"
          ).length >= 20
      )
        throw new ApiError(
          429,
          "Confirm pending registrations before creating more"
        );
      const result = await records.prepare(
        req.actor.address,
        entityType,
        attributes
      );
      await auth.authorize(bearer(req), entityType === 0 ? 1 : 2);
      res.status(201).json(result);
    })
  );
  app.post(
    "/api/records/:id/confirm",
    guard(),
    route(async (req, res) => {
      res.json(await records.confirm(req.params.id, req.actor.address));
    })
  );
  app.post(
    "/api/matches/evaluate",
    heavy,
    guard(0),
    route(async (req, res) => {
      exact(req.body, ["donorId", "recipientId"]);
      const result = await records.evaluate(
        req.body.donorId,
        req.body.recipientId
      );
      await auth.authorize(bearer(req), 0);
      await records.canonical(req.body.donorId);
      await records.canonical(req.body.recipientId);
      res.json(result);
    })
  );
  async function runJob(id, token) {
    const bundleCache = new Map();
    const job = store.get("jobs", id);
    job.state = "running";
    store.put("jobs", id, job);
    try {
      for (const donorId of job.donorIds)
        for (const recipientId of job.recipientIds) {
          await auth.authorize(token, 0);
          job.results.push(
            await records.evaluate(donorId, recipientId, bundleCache)
          );
          store.put("jobs", id, job);
          await new Promise((resolve) => setImmediate(resolve));
        }
      job.results.sort(
        (a, b) =>
          Number(b.eligible) - Number(a.eligible) ||
          (b.score ?? -1) - (a.score ?? -1) ||
          a.donorId.localeCompare(b.donorId) ||
          a.recipientId.localeCompare(b.recipientId)
      );
      job.state = "completed";
    } catch (e) {
      job.state = "failed";
      job.error =
        "Job interrupted, authorization changed, or record unavailable";
      job.results = [];
    }
    bundleCache.clear();
    store.put("jobs", id, job);
  }
  // A restart never resumes a job with a stored bearer token. Explicitly mark it interrupted.
  for (const job of store.list("jobs"))
    if (["queued", "running"].includes(job.state))
      store.put("jobs", job.id, {
        ...job,
        state: "failed",
        results: [],
        error: "Server restarted; submit a new job",
      });
  app.post(
    "/api/matches/jobs",
    heavy,
    guard(0),
    route(async (req, res) => {
      exact(req.body, ["donorIds", "recipientIds"]);
      const { donorIds, recipientIds } = req.body;
      for (const ids of [donorIds, recipientIds])
        if (
          !Array.isArray(ids) ||
          ids.length < 1 ||
          ids.length > 10 ||
          ids.some((id) => !validId(id)) ||
          new Set(ids).size !== ids.length
        )
          throw new ApiError(400, "Provide 1..10 unique record IDs per side");
      if (
        store
          .list("jobs")
          .some(
            (j) =>
              j.owner === req.actor.address &&
              ["queued", "running"].includes(j.state)
          )
      )
        throw new ApiError(429, "One active batch per wallet");
      const recent = store
        .list("jobs")
        .filter(
          (j) =>
            j.owner === req.actor.address && j.createdAt > Date.now() - 900000
        );
      if (
        recent.reduce(
          (n, j) => n + j.donorIds.length * j.recipientIds.length,
          0
        ) +
          donorIds.length * recipientIds.length >
        (limits.batchPairs || 200)
      )
        throw new ApiError(
          429,
          "Batch budget: 200 pairs per wallet per 15 minutes"
        );
      const id = crypto.randomUUID(),
        job = {
          owner: req.actor.address,
          donorIds,
          recipientIds,
          state: "queued",
          results: [],
          createdAt: Date.now(),
        };
      store.put("jobs", id, job);
      res.status(202).json({ id, state: "queued" });
      setImmediate(() => runJob(id, bearer(req)).catch(() => {}));
    })
  );
  app.get(
    "/api/matches/jobs/:id",
    guard(0),
    route(async (req, res) => {
      const job = store.get("jobs", req.params.id);
      if (!job) throw new ApiError(404, "Job not found");
      if (job.owner !== req.actor.address)
        throw new ApiError(403, "Job owner mismatch");
      for (const id of [...job.donorIds, ...job.recipientIds])
        await records.canonical(id);
      await auth.authorize(bearer(req), 0);
      res.json({ ...job, id: req.params.id });
    })
  );
  app.get(
    "/api/records/:id/revocation",
    guard(),
    route(async (req, res) => {
      if (!validId(req.params.id)) throw new ApiError(400, "Invalid ID");
      const record = store.get("records", req.params.id);
      if (!record) throw new ApiError(404, "Record missing");
      if (
        !(protocol.MASKS[req.actor.roleId] & 9) &&
        record.owner !== req.actor.address
      )
        throw new ApiError(403, "Revocation status forbidden");
      const status = await chain.revocationStatus(req.params.id);
      res.json({
        id: req.params.id,
        ...(store.get("revocations", req.params.id) || {}),
        state:
          store.get("revocations", req.params.id)?.state ||
          ["active", "requested", "deactivated"][status],
      });
    })
  );
  app.use((req, res) => res.status(404).json({ error: "Endpoint not found" }));
  app.use((error, req, res, next) => {
    const status =
      error.status || (error.type === "entity.parse.failed" ? 400 : 500);
    res.status(status).json({
      error:
        status < 500
          ? error.message
          : "Operation failed; check infrastructure and deployment",
    });
  });
  return app;
}
module.exports = { createApp };
