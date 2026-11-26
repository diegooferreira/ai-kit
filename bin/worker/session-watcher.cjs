#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { formatToolSummary } = require("./runner.cjs");

function normalizePathKey(p) {
  if (!p) return "";
  let raw = String(p).trim();
  if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(raw)) {
    raw = `${raw[1]}:${raw.slice(2)}`;
  }
  let n = path.resolve(raw).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") n = n.toLowerCase();
  return n;
}

function encodeClaudeProjectDir(projectPath) {
  // Claude Code transforma "d:\Projetos\monitoramento" -> "d--Projetos-monitoramento"
  const resolved = path.resolve(String(projectPath || "")).replace(/[\\/]+$/, "");
  return resolved.replace(/[:\\/]/g, "-");
}

function findClaudeProjectDirs(projectPath) {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsRoot)) return [];

  const expected = encodeClaudeProjectDir(projectPath).toLowerCase();
  const expectedLoose = expected.replace(/[^a-z0-9]/g, "");
  const baseName = path.basename(path.resolve(projectPath)).toLowerCase();

  let entries;
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const exact = [];
  const fallback = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const lower = e.name.toLowerCase();
    const full = path.join(projectsRoot, e.name);
    if (lower === expected || lower.replace(/[^a-z0-9]/g, "") === expectedLoose) {
      exact.push(full);
    } else if (baseName && lower.endsWith("-" + baseName)) {
      fallback.push(full);
    }
  }
  return exact.length > 0 ? exact : fallback;
}

function findNewestJsonl(dirs) {
  let newest = null;
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const full = path.join(dir, e.name);
      try {
        const st = fs.statSync(full);
        if (!newest || st.mtimeMs > newest.mtimeMs) {
          newest = { filePath: full, mtimeMs: st.mtimeMs, size: st.size };
        }
      } catch (_) {}
    }
  }
  return newest;
}

function readTailJsonLines(filePath, maxBytes = 40960) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
    const size = st.size;
    if (size === 0) return [];
    const readLen = Math.min(size, maxBytes);
    const start = size - readLen;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, start);
    const raw = buf.toString("utf8");
    const lines = raw.split(/\r?\n/);
    if (start > 0 && lines.length > 1) {
      lines.shift(); // descarta primeira linha possivelmente cortada no meio
    }
    const parsed = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        parsed.push(JSON.parse(trimmed));
      } catch (_) {}
    }
    return parsed;
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function formatRateLimitType(rawType) {
  const t = String(rawType || "").toLowerCase();
  if (t.includes("five_hour") || t.includes("5h")) return "limite 5h";
  if (t.includes("seven_day") || t.includes("7d")) return "limite 7d";
  return rawType ? `limite ${rawType}` : "limite de cota";
}

function isQuotaRecord(rec, text) {
  if (!rec) return false;
  if (rec.apiError === "usage_limit_reached") return true;
  if (rec.error === "rate_limit") return true;
  if (rec.apiErrorType === "rate_limit_error") return true;
  if (Number(rec.apiErrorStatus) === 429) return true;
  if (rec.quotaLimits && rec.quotaLimits.status === "rejected") return true;
  if (rec.apiErrorParams && rec.apiErrorParams.rate_limit_info && rec.apiErrorParams.rate_limit_info.status === "rejected") return true;
  if (text && /you['’]ve hit your .*limit|usage limit|rate limit reached/i.test(text)) return true;
  return false;
}

function extractTextFromMessage(msg) {
  if (!msg || !Array.isArray(msg.content)) return "";
  const parts = [];
  for (const block of msg.content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text.trim());
    }
  }
  return parts.join(" ").trim();
}

function inspectClaudeSession(projectPath) {
  const dirs = findClaudeProjectDirs(projectPath);
  if (dirs.length === 0) return { found: false };

  const newest = findNewestJsonl(dirs);
  if (!newest) return { found: false };

  const records = readTailJsonLines(newest.filePath, 40960);
  if (records.length === 0) return { found: false };

  const expectedNorm = normalizePathKey(projectPath);
  // Se o registro trouxer cwd explícito de outro projeto (em caso de fallback por basename), ignora
  const lastWithCwd = [...records].reverse().find((r) => typeof r.cwd === "string" && r.cwd.trim());
  if (lastWithCwd) {
    const cwdNorm = normalizePathKey(lastWithCwd.cwd);
    if (cwdNorm && cwdNorm !== expectedNorm && !cwdNorm.startsWith(expectedNorm + "/")) {
      return { found: false };
    }
  }

  let status = "IDLE";
  let quotaInfo = null;
  let apiErrorInfo = null;
  let lastTool = null;
  let lastPrompt = null;
  let lastTextSnippet = null;
  let lastMessageTsMs = 0;
  let expectingToolResult = false;
  let turnCompleted = false;
  let sessionCostUSD = null;
  let entrypoint = null;
  let model = null;

  for (const rec of records) {
    const recTsMs = rec.timestamp ? Date.parse(rec.timestamp) : 0;
    if (recTsMs && recTsMs > lastMessageTsMs) lastMessageTsMs = recTsMs;
    if (rec.entrypoint) entrypoint = rec.entrypoint;

    if (rec.type === "cost-state" && typeof rec.totalCostUSD === "number") {
      sessionCostUSD = rec.totalCostUSD;
      continue;
    }

    if (rec.type === "last-prompt" && typeof rec.lastPrompt === "string") {
      lastPrompt = rec.lastPrompt.trim().slice(0, 100);
      continue;
    }

    // Metadados gravados pelo Claude após o turno (não limpam erro de cota!)
    if (
      rec.type === "data-flow-records" ||
      rec.type === "tools-used" ||
      rec.type === "bridge-session" ||
      rec.type === "system" ||
      rec.type === "summary"
    ) {
      continue;
    }

    if (rec.type === "user") {
      // Novo turno do usuário (ou retorno de tool_result) invalida erro/cota de turno anterior
      quotaInfo = null;
      apiErrorInfo = null;
      turnCompleted = false;
      expectingToolResult = false;
      if (rec.message && Array.isArray(rec.message.content)) {
        const hasToolResult = rec.message.content.some((b) => b && b.type === "tool_result");
        if (hasToolResult) {
          turnCompleted = false;
        } else {
          const txt = extractTextFromMessage(rec.message);
          if (txt) lastPrompt = txt.slice(0, 100);
        }
      }
      continue;
    }

    if (rec.type === "assistant") {
      const msg = rec.message || {};
      if (msg.model && msg.model !== "<synthetic>") model = msg.model;
      const text = extractTextFromMessage(msg);

      if (isQuotaRecord(rec, text)) {
        const rl = (rec.apiErrorParams && rec.apiErrorParams.rate_limit_info) || rec.quotaLimits || {};
        const resetsAt = rl.resetsAt || (rec.quotaLimits && rec.quotaLimits.resetsAt) || null;
        const rateLimitType = rl.rateLimitType || (rec.quotaLimits && rec.quotaLimits.rateLimitType) || null;
        quotaInfo = {
          eventId: rec.uuid || `${rec.sessionId || "s"}:${resetsAt || rec.timestamp || newest.mtimeMs}`,
          resetsAt: resetsAt ? Number(resetsAt) : null,
          rateLimitType,
          limitLabel: formatRateLimitType(rateLimitType),
          rawText: text || "Limite de uso do Claude atingido.",
          timestampMs: recTsMs || newest.mtimeMs
        };
        apiErrorInfo = null;
        turnCompleted = true;
        expectingToolResult = false;
        continue;
      }

      if (rec.isApiErrorMessage || rec.apiError || rec.error) {
        apiErrorInfo = {
          eventId: rec.uuid || `${rec.sessionId || "s"}:${rec.timestamp || newest.mtimeMs}`,
          code: rec.apiError || rec.error || rec.apiErrorType || "api_error",
          status: rec.apiErrorStatus || null,
          rawText: text || String(rec.apiError || rec.error || "Erro na API do Claude"),
          timestampMs: recTsMs || newest.mtimeMs
        };
        quotaInfo = null;
        turnCompleted = true;
        expectingToolResult = false;
        continue;
      }

      // Mensagem normal de assistente limpa erro/cota anterior da mesma sessão
      quotaInfo = null;
      apiErrorInfo = null;

      if (Array.isArray(msg.content)) {
        const toolBlocks = msg.content.filter((b) => b && b.type === "tool_use");
        if (toolBlocks.length > 0) {
          const lastTb = toolBlocks[toolBlocks.length - 1];
          lastTool = formatToolSummary(lastTb.name, lastTb.input);
          expectingToolResult = true;
          turnCompleted = false;
        } else {
          expectingToolResult = false;
        }
      }

      if (text) {
        lastTextSnippet = text.split(/\r?\n/)[0].slice(0, 120);
      }

      if (msg.stop_reason === "end_turn") {
        turnCompleted = true;
        expectingToolResult = false;
      }
    }
  }

  const now = Date.now();
  const effectiveTsMs = Math.max(lastMessageTsMs || 0, newest.mtimeMs);
  const idleSec = Math.max(0, Math.round((now - effectiveTsMs) / 1000));

  let quotaExpired = false;
  if (quotaInfo) {
    if (quotaInfo.resetsAt && now >= quotaInfo.resetsAt * 1000) {
      status = "QUOTA_RESET_READY";
      quotaExpired = true;
    } else {
      status = "QUOTA_EXHAUSTED";
    }
  } else if (apiErrorInfo) {
    status = "API_ERROR";
  } else if ((expectingToolResult && idleSec <= 300) || (!turnCompleted && idleSec <= 60)) {
    status = "RUNNING";
  } else {
    status = "IDLE";
  }

  return {
    found: true,
    filePath: newest.filePath,
    mtimeMs: newest.mtimeMs,
    eventTimestampMs: effectiveTsMs,
    idleSec,
    status,
    quotaInfo,
    quotaExpired,
    apiErrorInfo,
    lastTool,
    lastPrompt,
    lastTextSnippet,
    sessionCostUSD,
    entrypoint,
    model
  };
}

function inspectAntigravityGlobal(activeWindowSec = 120) {
  // Usa apenas fs.statSync (zero lock no SQLite do Antigravity)
  const candidates = [
    path.join(os.homedir(), ".gemini", "antigravity", "conversation_summaries.db"),
    path.join(os.homedir(), ".gemini", "antigravity", "conversation_summaries.db-wal")
  ];

  let latestMs = 0;
  let sourceFile = null;
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if (st.mtimeMs > latestMs) {
        latestMs = st.mtimeMs;
        sourceFile = path.basename(p);
      }
    } catch (_) {}
  }

  if (!latestMs) {
    return { found: false, recentlyActive: false, idleSec: null };
  }

  const idleSec = Math.max(0, Math.round((Date.now() - latestMs) / 1000));
  return {
    found: true,
    sourceFile,
    mtimeMs: latestMs,
    idleSec,
    recentlyActive: idleSec <= activeWindowSec
  };
}

module.exports = {
  encodeClaudeProjectDir,
  inspectClaudeSession,
  inspectAntigravityGlobal,
  readTailJsonLines
};
