#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

function quoteCmdArg(arg) {
  const s = String(arg);
  if (!s) return '""';
  if (!/[\s"&|<>^()%]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Resolve executáveis no Windows priorizando .exe nativo sobre .cmd/.bat,
 * evitando `shell: true` (elimina DEP0190 no Node 24, preserva prompts multilinha e evita travamentos do cmd.exe).
 */
function resolveExecutable(bin) {
  const raw = String(bin || "").trim();
  if (process.platform !== "win32") {
    return { command: raw, prefixArgs: [], isCmd: false, resolvedPath: raw };
  }

  const isExplicit = raw.includes("\\") || raw.includes("/") || raw.includes(":");
  if (isExplicit) {
    const ext = path.extname(raw).toLowerCase();
    if (ext === ".cmd" || ext === ".bat") {
      return { command: raw, prefixArgs: [], isCmd: true, resolvedPath: raw };
    }
    return { command: raw, prefixArgs: [], isCmd: false, resolvedPath: raw };
  }

  const hasExt = Boolean(path.extname(raw));
  const pathDirs = String(process.env.PATH || "")
    .split(";")
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  // 1ª passada: prioriza binários nativos (.exe / .com) em todo o PATH
  const nativeExts = hasExt ? [""] : [".exe", ".com"];
  for (const ext of nativeExts) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, raw + ext);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const lower = candidate.toLowerCase();
        if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
          return { command: candidate, prefixArgs: [], isCmd: true, resolvedPath: candidate };
        }
        return { command: candidate, prefixArgs: [], isCmd: false, resolvedPath: candidate };
      }
    }
  }

  // 2ª passada: wrappers .cmd / .bat (ex.: openspec.cmd instalado via npm)
  if (!hasExt) {
    for (const ext of [".cmd", ".bat"]) {
      for (const dir of pathDirs) {
        const candidate = path.join(dir, raw + ext);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return { command: candidate, prefixArgs: [], isCmd: true, resolvedPath: candidate };
        }
      }
    }
  }

  return { command: raw, prefixArgs: [], isCmd: false, resolvedPath: raw };
}

function prepareSpawnInvocation(bin, args) {
  const resolved = resolveExecutable(bin);
  if (process.platform === "win32" && resolved.isCmd) {
    const comspec = process.env.ComSpec || "cmd.exe";
    const cmdLine = [quoteCmdArg(resolved.command), ...args.map(quoteCmdArg)].join(" ");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", `"${cmdLine}"`],
      extraOpts: { windowsVerbatimArguments: true, shell: false },
      resolvedPath: resolved.resolvedPath
    };
  }
  return {
    command: resolved.command,
    args,
    extraOpts: { shell: false },
    resolvedPath: resolved.resolvedPath
  };
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!num || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function killProcessTree(pid) {
  const num = Number(pid);
  if (!num || num <= 0) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(num), "/T", "/F"], {
        stdio: "ignore",
        timeout: 8000
      });
    } else {
      process.kill(num, "SIGTERM");
      setTimeout(() => {
        try { process.kill(num, "SIGKILL"); } catch (_) {}
      }, 2000).unref();
    }
  } catch (_) {
    try { process.kill(num, "SIGKILL"); } catch (__) {}
  }
}

function formatToolSummary(toolName, toolInput) {
  if (!toolName) return "";
  const input = toolInput || {};
  if (toolName === "Bash" && input.command) {
    return `Bash: ${String(input.command).slice(0, 90)}`;
  }
  if ((toolName === "Edit" || toolName === "Write" || toolName === "Read" || toolName === "MultiEdit") && (input.file_path || input.path)) {
    const p = String(input.file_path || input.path).replace(/\\/g, "/");
    const short = p.split("/").slice(-2).join("/");
    return `${toolName} ${short}`;
  }
  if (toolName === "Task" && input.description) {
    return `Subagente: ${String(input.description).slice(0, 70)}`;
  }
  return toolName;
}

class AgentRunner {
  constructor(opts) {
    this.kind = opts.kind; // "claude" | "agy"
    this.bin = opts.bin || opts.kind;
    this.args = opts.args || [];
    this.cwd = opts.cwd;
    this.env = opts.env || {};
    this.stallCodeSec = Number(opts.stallCodeSec) || 180;
    this.stallTestSec = Number(opts.stallTestSec) || 360;
    this.hardTimeoutMin = Number(opts.hardTimeoutMin) || 25;

    this.onUpdate = opts.onUpdate || (() => {});
    this.onStall = opts.onStall || (() => {});
    this.onQuota = opts.onQuota || (() => {});

    this.child = null;
    this.pid = null;
    this.startedAt = Date.now();
    this.lastEventAt = Date.now();
    this.lastSummary = "Inicializando CLI...";
    this.lastToolName = null;
    this.runningLongTool = false;
    this.stallSnoozeUntil = 0;
    this.stallAlerted = false;
    this.abortedByUser = false;
    this.timedOut = false;

    this.activeSubagents = new Map();
    this.logLines = [];
    this.rateLimit = null;
    this.finalText = "";
    this.totalCostUsd = null;
    this.quotaHit = false;
    this.authError = false;
    this.watchdogTimer = null;
    this.hardTimer = null;
  }

  pushLog(line) {
    const clean = String(line || "").replace(/\r/g, "").trim();
    if (!clean) return;
    this.logLines.push(`[${new Date().toTimeString().slice(0, 8)}] ${clean.slice(0, 260)}`);
    if (this.logLines.length > 60) {
      this.logLines.shift();
    }
  }

  touchActivity(summary, opts = {}) {
    this.lastEventAt = Date.now();
    this.stallAlerted = false;
    if (summary) this.lastSummary = summary;
    if (typeof opts.runningLongTool === "boolean") {
      this.runningLongTool = opts.runningLongTool;
    }
    this.onUpdate(this.getSnapshot());
  }

  snoozeStall(minutes = 5) {
    this.stallSnoozeUntil = Date.now() + minutes * 60 * 1000;
    this.stallAlerted = false;
    this.pushLog(`Watchdog adiado +${minutes} min pelo usuário.`);
  }

  handleHookEvent(ev) {
    const now = Date.now();
    const name = ev.eventName || "";
    const agentKey = ev.agentId || ev.agentType || null;

    if (name === "SubagentStart") {
      const id = agentKey || `sub-${now}`;
      this.activeSubagents.set(id, {
        id,
        type: ev.agentType || "subagente",
        startedAt: now,
        lastActivityAt: now,
        lastTool: "iniciado"
      });
      this.pushLog(`SubagentStart: ${ev.agentType || id}`);
      this.touchActivity(`Subagente iniciado: ${ev.agentType || id}`);
      return;
    }

    if (name === "SubagentStop") {
      if (agentKey && this.activeSubagents.has(agentKey)) {
        this.activeSubagents.delete(agentKey);
      } else if (this.activeSubagents.size > 0) {
        const firstKey = this.activeSubagents.keys().next().value;
        this.activeSubagents.delete(firstKey);
      }
      this.pushLog(`SubagentStop: ${ev.agentType || agentKey || "subagente"}`);
      this.touchActivity(`Subagente concluído: ${ev.agentType || "subagente"}`, { runningLongTool: false });
      return;
    }

    if (name === "PreToolUse") {
      const desc = formatToolSummary(ev.toolName, ev.toolInput);
      const isLong = ev.toolName === "Bash" || ev.toolName === "Task";
      if (agentKey && this.activeSubagents.has(agentKey)) {
        const sub = this.activeSubagents.get(agentKey);
        sub.lastActivityAt = now;
        sub.lastTool = desc;
      }
      this.lastToolName = ev.toolName;
      this.pushLog(`PreToolUse ${desc}`);
      this.touchActivity(`Executando ${desc}`, { runningLongTool: isLong });
      return;
    }

    if (name === "PostToolUse") {
      const desc = formatToolSummary(ev.toolName, ev.toolInput);
      if (agentKey && this.activeSubagents.has(agentKey)) {
        const sub = this.activeSubagents.get(agentKey);
        sub.lastActivityAt = now;
        sub.lastTool = `OK: ${desc}`;
      }
      this.pushLog(`PostToolUse ${desc}`);
      this.touchActivity(`OK: ${desc}`, { runningLongTool: false });
      return;
    }

    if (name === "StopFailure") {
      this.pushLog(`StopFailure: ${ev.error || "falha no agente"}`);
      this.touchActivity(`Falha reportada: ${ev.error || "StopFailure"}`, { runningLongTool: false });
    }
  }

  getSnapshot() {
    const now = Date.now();
    const subagents = Array.from(this.activeSubagents.values()).map((s) => ({
      type: s.type,
      elapsedSec: Math.round((now - s.startedAt) / 1000),
      idleSec: Math.round((now - s.lastActivityAt) / 1000),
      lastTool: s.lastTool
    }));
    return {
      kind: this.kind,
      pid: this.pid,
      alive: this.pid ? isPidAlive(this.pid) : false,
      elapsedSec: Math.round((now - this.startedAt) / 1000),
      idleSec: Math.round((now - this.lastEventAt) / 1000),
      lastSummary: this.lastSummary,
      runningLongTool: this.runningLongTool,
      subagents,
      rateLimit: this.rateLimit
    };
  }

  abort() {
    this.abortedByUser = true;
    this.stopTimers();
    if (this.pid) killProcessTree(this.pid);
  }

  stopTimers() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.watchdogTimer = null;
    this.hardTimer = null;
  }

  parseStdoutLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const ev = JSON.parse(trimmed);
        this.handleStreamJson(ev);
        return;
      } catch (_) {
        // Fallback para texto puro
      }
    }

    this.detectErrorSignals(trimmed);
    this.pushLog(trimmed);
    this.touchActivity(trimmed.slice(0, 120));
  }

  detectErrorSignals(text) {
    const lower = String(text || "").toLowerCase();
    if (/rate.?limit|quota.?exceeded|usage.?limit|resource_exhausted|hit your .*limit|too many requests|429\b|overloaded/i.test(lower)) {
      this.quotaHit = true;
    }
    if (/login required|not authenticated|please log in|unauthorized|oauth.*expired|run.*auth login/i.test(lower)) {
      this.authError = true;
    }
  }

  handleStreamJson(ev) {
    const now = Date.now();
    const parentId = ev.parent_tool_use_id || null;

    if (parentId) {
      if (!this.activeSubagents.has(parentId)) {
        this.activeSubagents.set(parentId, {
          id: parentId,
          type: "subagente",
          startedAt: now,
          lastActivityAt: now,
          lastTool: "em execução"
        });
      } else {
        this.activeSubagents.get(parentId).lastActivityAt = now;
      }
    }

    if (ev.type === "rate_limit_event" && ev.rate_limit_info) {
      const info = ev.rate_limit_info;
      const w5 = info.unifiedWindows && info.unifiedWindows.five_hour;
      const w7 = info.unifiedWindows && info.unifiedWindows.seven_day;
      this.rateLimit = {
        status: info.status || "unknown",
        fiveHourPct: w5 && typeof w5.utilization === "number" ? Math.round(w5.utilization * 100) : null,
        sevenDayPct: w7 && typeof w7.utilization === "number" ? Math.round(w7.utilization * 100) : null,
        resetsAt: (w5 && w5.resetsAt) || info.resetsAt || null
      };
      if (info.status && info.status !== "allowed") {
        this.quotaHit = true;
      }
      this.onQuota(this.rateLimit);
      this.touchActivity(this.lastSummary);
      return;
    }

    if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === "tool_use") {
          const desc = formatToolSummary(block.name, block.input);
          const isLong = block.name === "Bash" || block.name === "Task";
          if (block.name === "Task" && block.id) {
            this.activeSubagents.set(block.id, {
              id: block.id,
              type: (block.input && (block.input.subagent_type || block.input.description)) || "subagente",
              startedAt: now,
              lastActivityAt: now,
              lastTool: "disparado"
            });
          } else if (parentId && this.activeSubagents.has(parentId)) {
            this.activeSubagents.get(parentId).lastTool = desc;
          }
          this.pushLog(`Tool: ${desc}`);
          this.touchActivity(desc, { runningLongTool: isLong });
        } else if (block.type === "text" && block.text) {
          const snippet = block.text.trim().split(/\r?\n/)[0] || "";
          if (snippet) {
            this.pushLog(snippet);
            this.touchActivity(snippet.slice(0, 120));
          }
        }
      }
      return;
    }

    if (ev.type === "stream_event") {
      this.lastEventAt = now;
      this.stallAlerted = false;
      return;
    }

    if (ev.type === "result") {
      if (typeof ev.result === "string") this.finalText = ev.result;
      if (typeof ev.total_cost_usd === "number") this.totalCostUsd = ev.total_cost_usd;
      if (ev.is_error || ev.subtype === "error") {
        this.detectErrorSignals(ev.result || ev.error || "");
      }
      this.pushLog(`Result (${ev.subtype || "done"})`);
      this.touchActivity(`Finalizado (${ev.subtype || "ok"})`, { runningLongTool: false });
      return;
    }

    if (ev.type === "error" || ev.error) {
      const msg = typeof ev.error === "string" ? ev.error : JSON.stringify(ev.error || ev);
      this.detectErrorSignals(msg);
      this.pushLog(`Erro: ${msg}`);
      this.touchActivity(`Erro: ${msg.slice(0, 100)}`, { runningLongTool: false });
      return;
    }

    const textCandidate = ev.text || ev.delta || ev.message || "";
    if (typeof textCandidate === "string" && textCandidate.trim()) {
      this.detectErrorSignals(textCandidate);
      this.pushLog(textCandidate.trim().slice(0, 180));
      this.touchActivity(textCandidate.trim().slice(0, 120));
    } else {
      this.lastEventAt = now;
    }
  }

  start() {
    return new Promise((resolve) => {
      const inv = prepareSpawnInvocation(this.bin, this.args);
      const spawnOpts = {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...inv.extraOpts
      };

      this.startedAt = Date.now();
      this.lastEventAt = Date.now();
      this.pushLog(`Spawn: ${inv.resolvedPath} (cwd=${this.cwd})`);

      try {
        this.child = spawn(inv.command, inv.args, spawnOpts);
        // Fecha stdin imediatamente (EOF limpo sem usar NUL, evitando hang em CLIs Go/Node no Windows)
        if (this.child && this.child.stdin) {
          this.child.stdin.end();
        }
      } catch (err) {
        resolve({
          exitCode: 1,
          finalText: "",
          error: `Falha ao iniciar ${this.bin}: ${err.message}`,
          quotaHit: false,
          authError: false,
          abortedByUser: false,
          timedOut: false,
          logTail: this.logLines.slice(-25),
          rateLimit: this.rateLimit
        });
        return;
      }

      this.pid = this.child.pid;
      this.touchActivity(`Iniciado (${this.bin} · PID ${this.pid})`);

      let stdoutBuf = "";
      this.child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString("utf8");
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() || "";
        for (const line of lines) this.parseStdoutLine(line);
      });

      let stderrBuf = "";
      this.child.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf8");
        const lines = stderrBuf.split(/\r?\n/);
        stderrBuf = lines.pop() || "";
        for (const line of lines) {
          const clean = line.trim();
          if (!clean) continue;
          this.detectErrorSignals(clean);
          this.pushLog(`[stderr] ${clean}`);
          this.lastEventAt = Date.now();
        }
      });

      // Watchdog de Silêncio (monitora processo principal + subagentes ativos)
      this.watchdogTimer = setInterval(() => {
        const now = Date.now();
        if (now < this.stallSnoozeUntil) return;
        const limitSec = this.runningLongTool ? this.stallTestSec : this.stallCodeSec;
        const idleSec = Math.round((now - this.lastEventAt) / 1000);
        if (idleSec >= limitSec && !this.stallAlerted) {
          this.stallAlerted = true;
          this.onStall(this.getSnapshot(), limitSec);
        }
      }, 15000);

      // Hard timeout por etapa
      this.hardTimer = setTimeout(() => {
        this.timedOut = true;
        this.pushLog(`Hard timeout atingido (${this.hardTimeoutMin} min). Encerrando árvore de processos.`);
        if (this.pid) killProcessTree(this.pid);
      }, this.hardTimeoutMin * 60 * 1000);

      this.child.on("error", (err) => {
        this.stopTimers();
        this.pushLog(`Erro de processo: ${err.message}`);
        resolve({
          exitCode: 1,
          finalText: this.finalText,
          error: err.message,
          quotaHit: this.quotaHit,
          authError: this.authError,
          abortedByUser: this.abortedByUser,
          timedOut: this.timedOut,
          logTail: this.logLines.slice(-25),
          rateLimit: this.rateLimit
        });
      });

      this.child.on("close", (code) => {
        this.stopTimers();
        if (stdoutBuf.trim()) this.parseStdoutLine(stdoutBuf);
        if (stderrBuf.trim()) {
          this.detectErrorSignals(stderrBuf);
          this.pushLog(`[stderr] ${stderrBuf.trim()}`);
        }
        resolve({
          exitCode: typeof code === "number" ? code : 1,
          finalText: this.finalText,
          totalCostUsd: this.totalCostUsd,
          quotaHit: this.quotaHit,
          authError: this.authError,
          abortedByUser: this.abortedByUser,
          timedOut: this.timedOut,
          logTail: this.logLines.slice(-25),
          rateLimit: this.rateLimit
        });
      });
    });
  }
}

function buildClaudeArgs(prompt, defaults, project) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "default"
  ];
  const model = (project && project.claudeModel) || defaults.claudeModel;
  if (model) {
    args.push("--model", model);
  }
  return args;
}

function buildAgyArgs(prompt, stage, defaults, project) {
  const effortMap = {
    explore: defaults.agyExploreEffort || "high",
    propose: defaults.agyProposeEffort || "high",
    homologar: defaults.agyQaEffort || "medium"
  };
  const mode = stage === "homologar"
    ? (defaults.agyQaMode || "auto")
    : (defaults.agySpecMode || "accept-edits");
  const timeoutSec = Math.max(60, (Number(defaults.stageTimeoutMin) || 25) * 60);

  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--mode",
    mode,
    "--effort",
    effortMap[stage] || "medium",
    "--print-timeout",
    `${timeoutSec}s`
  ];
  const model = (project && project.agyModel) || defaults.agyModel;
  if (model) {
    args.push("--model", model);
  }
  if (project && project.agyLogFile) {
    try { fs.mkdirSync(path.dirname(project.agyLogFile), { recursive: true }); } catch (_) {}
    args.push("--log-file", project.agyLogFile);
  }
  return args;
}

module.exports = {
  AgentRunner,
  isPidAlive,
  killProcessTree,
  buildClaudeArgs,
  buildAgyArgs,
  formatToolSummary,
  resolveExecutable,
  prepareSpawnInvocation
};
