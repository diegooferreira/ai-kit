#!/usr/bin/env node
// managed-by: ai-kit
// Hook multi-evento (SubagentStart|SubagentStop|PreToolUse|PostToolUse|PermissionRequest|StopFailure):
// Inativo (no-op em <5ms) no uso manual. Quando AI_KIT_WORKER_URL está definido, reporta atividade
// real de subagentes/ferramentas ao worker local e encaminha PermissionRequest para aprovação no Telegram.
"use strict";

const fs = require("fs");

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

async function postJson(endpoint, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WORKER_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Token": WORKER_TOKEN
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

async function main() {
  if (!WORKER_URL) {
    emit({});
    return;
  }

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
  const envelope = {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    eventName,
    toolName: payload.tool_name || null,
    toolInput: payload.tool_input || null,
    agentId: payload.agent_id || payload.subagent_id || null,
    agentType: payload.agent_type || payload.subagent_type || null,
    sessionId: payload.session_id || null,
    cwd: payload.cwd || null,
    error: payload.error || payload.reason || null,
    timestamp: new Date().toISOString()
  };

  if (eventName === "PermissionRequest") {
    // Espera até 16 min pela decisão no Telegram (worker aplica fail-closed em 15 min)
    const reply = await postJson("/hook/permission", envelope, 16 * 60 * 1000);
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

  // Eventos de telemetria (SubagentStart/Stop, Pre/PostToolUse, StopFailure): nunca travam o Claude
  await postJson("/hook/event", envelope, 1500);
  emit({});
}

main().catch(() => emit({}));
