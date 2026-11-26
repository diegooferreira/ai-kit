#!/usr/bin/env node
// managed-by: ai-kit
// Hook multi-evento (UserPromptSubmit|SubagentStart|SubagentStop|PreToolUse|PostToolUse|PermissionRequest|Stop|StopFailure):
// 1) Modo Gerenciado (AI_KIT_WORKER_URL definido): telemetria + PermissionRequest síncrono no Telegram.
// 2) Modo Espelho Passivo (VS Code / terminal): descobre o worker via ~/.ai-kit-worker-runtime.json
//    (com fallback USERPROFILE/HOME/tmpdir para compatibilidade PowerShell + Git Bash no Windows),
//    envia telemetria rápida (350ms) e SEMPRE retorna {} imediatamente sem bloquear o VS Code.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const WORKER_URL = process.env.AI_KIT_WORKER_URL || "";
const WORKER_TOKEN = process.env.AI_KIT_WORKER_TOKEN || "";
const PROJECT_ID = process.env.AI_KIT_PROJECT_ID || "";
const RUN_ID = process.env.AI_KIT_RUN_ID || "";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (_) {
    return "";
  }
}

function normalizeForCompare(p) {
  if (!p) return "";
  let raw = String(p).trim();
  // Converte caminhos MSYS2/Git Bash (/d/Projetos/...) para d:/Projetos/... no Windows
  if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(raw)) {
    raw = `${raw[1]}:${raw.slice(2)}`;
  }
  let n = path.resolve(raw).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") n = n.toLowerCase();
  return n;
}

function candidateDiscoveryPaths() {
  const dirs = new Set();
  try { dirs.add(os.homedir()); } catch (_) {}
  if (process.env.USERPROFILE) dirs.add(process.env.USERPROFILE);
  if (process.env.HOME) dirs.add(process.env.HOME);
  const out = [];
  for (const d of dirs) {
    if (d) out.push(path.join(d, ".ai-kit-worker-runtime.json"));
  }
  try { out.push(path.join(os.tmpdir(), "ai-kit-worker-runtime.json")); } catch (_) {}
  return out;
}

function discoverActiveWorker(cwdCandidate) {
  let rt = null;
  for (const p of candidateDiscoveryPaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (parsed && parsed.url && parsed.token && parsed.projects) {
        rt = parsed;
        break;
      }
    } catch (_) {}
  }
  if (!rt) return null;

  const targetNorm = normalizeForCompare(cwdCandidate || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!targetNorm) return null;

  let best = null;
  for (const [id, projPath] of Object.entries(rt.projects)) {
    const pNorm = normalizeForCompare(projPath);
    if (!pNorm) continue;
    if (targetNorm === pNorm || targetNorm.startsWith(pNorm + "/")) {
      if (!best || pNorm.length > best.len) {
        best = { projectId: id, len: pNorm.length };
      }
    }
  }
  if (!best) return null;

  return {
    url: rt.url,
    token: rt.token,
    projectId: best.projectId
  };
}

async function postJson(baseUrl, token, endpoint, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Token": token
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizePromptHint(rawPrompt) {
  if (typeof rawPrompt !== "string") return null;
  const firstLine = rawPrompt.trim().split(/\r?\n/)[0] || "";
  return firstLine.slice(0, 80) || null;
}

async function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    emit({});
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    emit({});
    return;
  }

  const eventName = String(payload.hook_event_name || "");

  // --- MODO 1: Gerenciado diretamente pelo AI-Kit Worker ---
  if (WORKER_URL) {
    const envelope = {
      projectId: PROJECT_ID,
      runId: RUN_ID,
      source: "worker",
      eventName,
      toolName: payload.tool_name || null,
      toolInput: payload.tool_input || null,
      agentId: payload.agent_id || payload.subagent_id || null,
      agentType: payload.agent_type || payload.subagent_type || null,
      sessionId: payload.session_id || null,
      cwd: payload.cwd || null,
      error: payload.error || payload.reason || null,
    errorDetails: payload.error_details || payload.api_error || null,
    lastAssistantMessage: sanitizePromptHint(payload.last_assistant_message),
      errorDetails: payload.error_details || payload.api_error || null,
      lastAssistantMessage: sanitizePromptHint(payload.last_assistant_message),
      promptHint: sanitizePromptHint(payload.prompt),
      timestamp: new Date().toISOString()
    };

    if (eventName === "PermissionRequest") {
      const reply = await postJson(WORKER_URL, WORKER_TOKEN, "/hook/permission", envelope, 16 * 60 * 1000);
      if (reply && reply.decision === "allow") {
        emit({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" }
          }
        });
        return;
      }
      const reason = (reply && reply.reason)
        || "Permissão negada ou expirada no Telegram (fail-closed).";
      emit({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: reason }
        }
      });
      return;
    }

    await postJson(WORKER_URL, WORKER_TOKEN, "/hook/event", envelope, 1500);
    emit({});
    return;
  }

  // --- MODO 2: Espelho Passivo (sessão manual no VS Code / terminal) ---
  const mirror = discoverActiveWorker(payload.cwd || process.env.CLAUDE_PROJECT_DIR);
  if (!mirror) {
    emit({});
    return;
  }

  // Self-test isolado (`ai-kit worker test-bridge`): testa conectividade sem sujar o Card
  if (eventName === "Ping") {
    const pong = await postJson(mirror.url, mirror.token, "/hook/ping", {
      projectId: mirror.projectId,
      source: "test-bridge"
    }, 1500);
    emit({ ok: Boolean(pong && pong.pong), projectId: mirror.projectId, workerUrl: mirror.url });
    return;
  }

  const mirrorEnvelope = {
    projectId: mirror.projectId,
    source: "vscode",
    eventName,
    toolName: payload.tool_name || null,
    toolInput: payload.tool_input || null,
    agentId: payload.agent_id || payload.subagent_id || null,
    agentType: payload.agent_type || payload.subagent_type || null,
    sessionId: payload.session_id || null,
    cwd: payload.cwd || process.env.CLAUDE_PROJECT_DIR || null,
    error: payload.error || payload.reason || null,
    errorDetails: payload.error_details || payload.api_error || null,
    lastAssistantMessage: sanitizePromptHint(payload.last_assistant_message),
    promptHint: sanitizePromptHint(payload.prompt),
    timestamp: new Date().toISOString()
  };

  // Timeout curto (350ms) e retorno {} imediato — nunca trava nem interfere no VS Code
  await postJson(mirror.url, mirror.token, "/hook/mirror-event", mirrorEnvelope, 350);
  emit({});
}

main().catch(() => emit({}));
