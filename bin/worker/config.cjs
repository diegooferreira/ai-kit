#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const KIT_ROOT = path.resolve(__dirname, "..", "..");
const LEGACY_WORKER_HOME = path.join(os.homedir(), ".ai-kit-worker");
const WORKER_HOME = process.env.AI_KIT_WORKER_HOME || path.join(KIT_ROOT, ".worker-data");
const CONFIG_PATH = path.join(WORKER_HOME, "config.json");
const STATE_PATH = path.join(WORKER_HOME, "state.json");
const EVENTS_LOG = path.join(WORKER_HOME, "events.ndjson");

const DEFAULT_CONFIG = {
  version: 1,
  telegram: {
    botToken: "",
    chatId: null,
    allowedUserId: null,
    generalThreadId: null
  },
  hookServer: {
    host: "127.0.0.1",
    port: 4790
  },
  defaults: {
    claudeBin: "claude",
    agyBin: "agy",
    claudeModel: "",
    agyModel: "",
    agyExploreEffort: "high",
    agyProposeEffort: "high",
    agyQaEffort: "medium",
    agySpecMode: "accept-edits",
    agyQaMode: "auto",
    stallCodeSec: 180,
    stallTestSec: 360,
    stageTimeoutMin: 25,
    permissionTimeoutMin: 15,
    cardRefreshSec: 60
  },
  projects: {}
};

let migrationChecked = false;

function ensureHome() {
  fs.mkdirSync(WORKER_HOME, { recursive: true });
}

function migrateLegacyDataIfNeeded() {
  if (migrationChecked) return;
  migrationChecked = true;

  if (path.resolve(WORKER_HOME) === path.resolve(LEGACY_WORKER_HOME)) return;
  if (fs.existsSync(CONFIG_PATH)) return;

  const legacyCfg = path.join(LEGACY_WORKER_HOME, "config.json");
  if (!fs.existsSync(legacyCfg)) return;

  try {
    ensureHome();
    for (const file of ["config.json", "state.json", "events.ndjson"]) {
      const src = path.join(LEGACY_WORKER_HOME, file);
      const dst = path.join(WORKER_HOME, file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
    console.log(`[ai-kit worker] Configuração migrada automaticamente de ${LEGACY_WORKER_HOME} -> ${WORKER_HOME}`);
  } catch (_) {
    // Se falhar, segue sem interromper
  }
}

function writeJsonAtomic(filePath, data) {
  ensureHome();
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, filePath);
}

function loadConfig() {
  ensureHome();
  migrateLegacyDataIfNeeded();
  if (!fs.existsSync(CONFIG_PATH)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      telegram: { ...DEFAULT_CONFIG.telegram, ...(parsed.telegram || {}) },
      hookServer: { ...DEFAULT_CONFIG.hookServer, ...(parsed.hookServer || {}) },
      defaults: { ...DEFAULT_CONFIG.defaults, ...(parsed.defaults || {}) },
      projects: parsed.projects || {}
    };
  } catch (err) {
    throw new Error(`Falha ao ler ${CONFIG_PATH}: ${err.message}`);
  }
}

function saveConfig(cfg) {
  writeJsonAtomic(CONFIG_PATH, cfg);
}

function loadState() {
  ensureHome();
  migrateLegacyDataIfNeeded();
  if (!fs.existsSync(STATE_PATH)) {
    return { updatedAt: null, runs: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return {
      updatedAt: parsed.updatedAt || null,
      runs: parsed.runs || {}
    };
  } catch (_) {
    return { updatedAt: null, runs: {} };
  }
}

function saveState(state) {
  const payload = {
    updatedAt: new Date().toISOString(),
    runs: state.runs || {}
  };
  writeJsonAtomic(STATE_PATH, payload);
}

function appendEvent(entry) {
  try {
    ensureHome();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(EVENTS_LOG, line + "\n", "utf8");
  } catch (_) {}
}

function maskToken(token) {
  const t = String(token || "");
  if (t.length < 12) return "(não configurado)";
  return `${t.slice(0, 6)}...${t.slice(-4)}`;
}

function slugifyProject(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
}

function findProjectByThread(cfg, threadId) {
  const num = threadId == null ? null : Number(threadId);
  for (const [id, proj] of Object.entries(cfg.projects || {})) {
    if (proj.threadId != null && Number(proj.threadId) === num) {
      return { id, ...proj };
    }
  }
  return null;
}

module.exports = {
  KIT_ROOT,
  LEGACY_WORKER_HOME,
  WORKER_HOME,
  CONFIG_PATH,
  STATE_PATH,
  EVENTS_LOG,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  appendEvent,
  maskToken,
  slugifyProject,
  findProjectByThread
};
