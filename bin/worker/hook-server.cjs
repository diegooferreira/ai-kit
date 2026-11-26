#!/usr/bin/env node
"use strict";

const http = require("http");
const crypto = require("crypto");

class HookBridgeServer {
  constructor(opts) {
    this.host = opts.host || "127.0.0.1";
    this.port = Number(opts.port) || 4790;
    this.token = crypto.randomBytes(24).toString("hex");
    this.permissionTimeoutMs = (Number(opts.permissionTimeoutMin) || 15) * 60 * 1000;
    this.onEvent = opts.onEvent || (() => {});
    this.onMirrorEvent = opts.onMirrorEvent || (() => {});
    this.onPermissionRequest = opts.onPermissionRequest || (() => {});
    this.pending = new Map();
    this.server = null;
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", reject);
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        this.port = addr.port;
        resolve({ url: this.url, token: this.token });
      });
    });
  }

  stop() {
    for (const [reqId, item] of this.pending.entries()) {
      clearTimeout(item.timer);
      item.resolve({ decision: "deny", reason: "Worker encerrado." });
      this.pending.delete(reqId);
    }
    if (this.server) {
      try { this.server.close(); } catch (_) {}
    }
  }

  resolvePermission(reqId, decision, reason = "") {
    const entry = this.pending.get(reqId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(reqId);
    entry.resolve({
      decision: decision === "allow" ? "allow" : "deny",
      reason: reason || (decision === "allow" ? "Aprovado pelo usuário no Telegram." : "Negado pelo usuário no Telegram.")
    });
    return true;
  }

  async handleRequest(req, res) {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    const auth = req.headers["x-worker-token"];
    if (auth !== this.token) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Token inválido." }));
      return;
    }

    let bodyRaw = "";
    for await (const chunk of req) {
      bodyRaw += chunk;
      if (bodyRaw.length > 1024 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
    }

    let payload;
    try {
      payload = bodyRaw ? JSON.parse(bodyRaw) : {};
    } catch (_) {
      res.writeHead(400);
      res.end();
      return;
    }

    if (req.url === "/hook/ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pong: true, projectId: payload.projectId || null, ts: new Date().toISOString() }));
      return;
    }

    if (req.url === "/hook/event") {
      try {
        this.onEvent(payload);
      } catch (_) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/hook/mirror-event") {
      try {
        this.onMirrorEvent(payload);
      } catch (_) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/hook/permission") {
      const reqId = crypto.randomBytes(6).toString("hex");
      const decisionPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(reqId);
          resolve({
            decision: "deny",
            reason: `Timeout fail-closed (${Math.round(this.permissionTimeoutMs / 60000)} min sem resposta no Telegram).`
          });
        }, this.permissionTimeoutMs);
        this.pending.set(reqId, { resolve, timer, payload, createdAt: Date.now() });
      });

      try {
        await this.onPermissionRequest(reqId, payload);
      } catch (err) {
        this.resolvePermission(reqId, "deny", `Erro ao notificar Telegram: ${err.message}`);
      }

      const result = await decisionPromise;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end();
  }
}

module.exports = { HookBridgeServer };
