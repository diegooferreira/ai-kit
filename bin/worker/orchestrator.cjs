#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  WORKER_HOME,
  loadState,
  saveState,
  appendEvent,
  findProjectByThread
} = require("./config.cjs");
const {
  inspectClaudeSession,
  inspectAntigravityGlobal
} = require("./session-watcher.cjs");
const {
  buildChangeName,
  ensureWorktree,
  auditBoundary,
  parseProposalRisk,
  parseReviewReport,
  readHandoffSnippet,
  listPendingSlices,
  detectManualSession,
  inspectMainCheckout,
  parseTasksProgress,
  listDirtyFiles,
  collectTelemetry
} = require("./git-worktree.cjs");
const {
  AgentRunner,
  isPidAlive,
  buildClaudeArgs,
  buildAgyArgs,
  formatToolSummary
} = require("./runner.cjs");

function fmtDuration(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

function fmtClock() {
  return new Date().toTimeString().slice(0, 8);
}

function fmtResetTime(epochSec) {
  if (!epochSec) return "";
  const d = new Date(Number(epochSec) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 5);
}

const MILESTONE_PHASES = new Set([
  "AGUARDANDO_APROVACAO",
  "PRONTA_PARA_HOMOLOGACAO",
  "HOMOLOGADO",
  "AGUARDANDO_HUMANO",
  "BLOQUEADA"
]);

class WorkerOrchestrator {
  constructor(cfg, telegram, hookServer) {
    this.cfg = cfg;
    this.tg = telegram;
    this.hookServer = hookServer;
    this.state = loadState();
    this.activeRunners = new Map();
    this.pendingPermsMeta = new Map();
    this.mirrors = new Map();
    this.cardTimer = null;
    this.mirrorTimer = null;
  }

  get chatId() {
    return this.cfg.telegram.chatId;
  }

  get allowedUserId() {
    return Number(this.cfg.telegram.allowedUserId);
  }

  getRun(projectId) {
    if (!this.state.runs[projectId]) {
      this.state.runs[projectId] = {
        projectId,
        status: "IDLE",
        stage: null,
        changeName: null,
        worktreePath: null,
        branchName: null,
        risk: null,
        pcApprovedHighRisk: false,
        pid: null,
        iaLabel: null,
        cardMessageId: null,
        pauseRequested: false,
        lastSummary: "Ocioso",
        rateLimit: null,
        updatedAt: new Date().toISOString()
      };
    }
    return this.state.runs[projectId];
  }

  getMirror(projectId) {
    if (!this.mirrors.has(projectId)) {
      this.mirrors.set(projectId, {
        activeSubagents: new Map(),
        logLines: [],
        lastEventAt: 0,
        lastEventName: null,
        lastSummary: null,
        runningLongTool: false,
        turnStopped: false,
        idleAlertSent: false,
        sessionNotifiedAt: 0,
        lastCardPushAt: 0,
        lastDiskKey: "",
        lastChangeName: null,
        lastNotifiedPhase: null,
        lastNotifiedQuotaId: null,
        lastNotifiedErrorId: null,
        pendingQuotaResetAt: null,
        quotaNotifiedResetLabel: null,
        claudeSession: null,
        antigravityGlobal: null,
        disk: null,
        seeded: false
      });
    }
    return this.mirrors.get(projectId);
  }

  persist() {
    saveState(this.state);
  }

  async start() {
    await this.recoverInterruptedRuns();
    await this.seedMirrorSnapshots();

    const refreshMs = Math.max(20, Number(this.cfg.defaults.cardRefreshSec) || 60) * 1000;
    this.cardTimer = setInterval(() => {
      for (const projectId of this.activeRunners.keys()) {
        this.refreshCard(projectId, false).catch(() => {});
      }
    }, refreshMs);

    const mirrorPollMs = Math.max(8, Number(this.cfg.defaults.mirrorPollSec) || 15) * 1000;
    this.mirrorTimer = setInterval(() => {
      this.pollMirrors().catch(() => {});
    }, mirrorPollMs);

    try {
      await this.tg.setMyCommands([
        { command: "status", description: "Ver status real (Worker ou VS Code espelhado)" },
        { command: "fila", description: "Listar próximas fatias do projeto" },
        { command: "iniciar", description: "Iniciar change: /iniciar <slug>" },
        { command: "explorar", description: "Rodar openspec-explore: /explorar <slug>" },
        { command: "propor", description: "Rodar openspec-propose + revisão: /propor <slug>" },
        { command: "homologar", description: "Rodar homologar-change no worktree ativo" },
        { command: "telemetria", description: "Rodar ai-kit telemetry (worktree ou checkout principal)" },
        { command: "logs", description: "Ver últimas 25 linhas/eventos (Worker ou VS Code)" },
        { command: "pausar", description: "Pausar após a etapa atual" },
        { command: "retomar", description: "Retomar change via handoff.md" },
        { command: "abortar", description: "Matar processo ativo preservando worktree" },
        { command: "ajuda", description: "Mostrar comandos disponíveis" }
      ]);
    } catch (_) {}

    if (this.chatId) {
      const names = Object.keys(this.cfg.projects || {});
      await this.tg.sendMessage(
        this.chatId,
        `🟢 AI-Kit Worker v2.2.5 online (Modo Espelho VS Code ativo).\nProjetos monitorados (${names.length}): ${names.join(", ") || "nenhum"}\nUse /status dentro do tópico de cada projeto.`,
        { threadId: this.cfg.telegram.generalThreadId, silent: true }
      ).catch(() => {});
    }
  }

  stop() {
    if (this.cardTimer) clearInterval(this.cardTimer);
    if (this.mirrorTimer) clearInterval(this.mirrorTimer);
    for (const runner of this.activeRunners.values()) {
      runner.abort();
    }
    this.activeRunners.clear();
  }

  async seedMirrorSnapshots() {
    for (const [projectId, proj] of Object.entries(this.cfg.projects || {})) {
      if (!proj || !fs.existsSync(proj.path)) continue;
      const m = this.getMirror(projectId);
      const diskWindowSec = Number(this.cfg.defaults.diskActiveWindowSec) || 120;
      const disk = inspectMainCheckout(proj.path, diskWindowSec);
      const claudeSession = inspectClaudeSession(proj.path);
      const agyGlobal = inspectAntigravityGlobal(diskWindowSec);
      m.disk = disk;
      m.claudeSession = claudeSession;
      m.antigravityGlobal = agyGlobal;
      m.seeded = true;

      if (claudeSession.found && claudeSession.status === "QUOTA_EXHAUSTED" && claudeSession.quotaInfo) {
        m.lastNotifiedQuotaId = claudeSession.quotaInfo.eventId;
        if (claudeSession.quotaInfo.resetsAt) {
          m.pendingQuotaResetAt = claudeSession.quotaInfo.resetsAt;
          m.quotaNotifiedResetLabel = fmtResetTime(claudeSession.quotaInfo.resetsAt);
        }
      }

      if (disk.hasActiveChange || (claudeSession.found && claudeSession.status === "QUOTA_EXHAUSTED")) {
        if (disk.hasActiveChange) {
          m.lastChangeName = disk.changeName;
          m.lastNotifiedPhase = disk.phase;
        }
        m.lastDiskKey = this.computeMirrorKey(disk, claudeSession, agyGlobal);
        const run = this.getRun(projectId);
        if (run.status === "IDLE") {
          await this.refreshCard(projectId, !run.cardMessageId).catch(() => {});
        }
      }
    }
  }

  computeMirrorKey(disk, claudeSession, agyGlobal) {
    const csPart = claudeSession && claudeSession.found
      ? `${claudeSession.status}:${claudeSession.lastTool || ""}:${claudeSession.quotaInfo ? claudeSession.quotaInfo.eventId : ""}`
      : "no-cs";
    const agyPart = agyGlobal && agyGlobal.recentlyActive ? "agy-on" : "agy-off";
    if (disk && disk.hasActiveChange) {
      return `${disk.changeName}|${disk.phase}|${disk.tasks.done}/${disk.tasks.total}|${disk.dirtyCount}|${disk.diskRecentlyActive}|${csPart}|${agyPart}`;
    }
    return `none|${disk ? disk.dirtyCount : 0}|${disk ? disk.diskRecentlyActive : false}|${csPart}|${agyPart}`;
  }

  async pollMirrors() {
    for (const [projectId, proj] of Object.entries(this.cfg.projects || {})) {
      if (this.activeRunners.has(projectId)) continue;
      if (!proj || !fs.existsSync(proj.path)) continue;
      await this.pollMirrorProject(projectId, false);
    }
  }

  async pollMirrorProject(projectId, fromStopEvent = false) {
    const proj = this.cfg.projects[projectId];
    if (!proj || !fs.existsSync(proj.path)) return;
    if (this.activeRunners.has(projectId)) return;

    const run = this.getRun(projectId);
    const m = this.getMirror(projectId);
    const diskWindowSec = Number(this.cfg.defaults.diskActiveWindowSec) || 120;
    const disk = inspectMainCheckout(proj.path, diskWindowSec);
    const claudeSession = inspectClaudeSession(proj.path);
    const agyGlobal = inspectAntigravityGlobal(diskWindowSec);
    m.disk = disk;
    m.claudeSession = claudeSession;
    m.antigravityGlobal = agyGlobal;

    const now = Date.now();
    const diskKey = this.computeMirrorKey(disk, claudeSession, agyGlobal);
    const changed = diskKey !== m.lastDiskKey;

    // 0a. Detecção determinística de COTA ESGOTADA no Claude (via .jsonl da sessão — funciona mesmo sem hook)
    if (run.status === "IDLE" && claudeSession.found && claudeSession.status === "QUOTA_EXHAUSTED" && claudeSession.quotaInfo) {
      const qi = claudeSession.quotaInfo;
      if (m.lastNotifiedQuotaId !== qi.eventId) {
        m.lastNotifiedQuotaId = qi.eventId;
        m.idleAlertSent = true;
        m.turnStopped = true;
        if (qi.resetsAt) {
          m.pendingQuotaResetAt = qi.resetsAt;
          m.quotaNotifiedResetLabel = fmtResetTime(qi.resetsAt);
        }
        m.lastDiskKey = diskKey;
        const resetLabel = qi.resetsAt ? ` às ${fmtResetTime(qi.resetsAt)}` : "";
        const chLine = disk.hasActiveChange
          ? `
Change: ${disk.changeName}
Tasks: ${disk.tasks.exists ? `${disk.tasks.done}/${disk.tasks.total} [x] (${disk.tasks.pct}%)` : "—"}`
          : "";
        await this.refreshCard(projectId, !run.cardMessageId).catch(() => {});
        await this.tg.sendMessage(
          this.chatId,
          `⏳ Cota do Claude atingida no VS Code — ${projectId} (${qi.limitLabel})${chLine}
Reset previsto:${resetLabel || " conferir no VS Code"}
Você será avisado automaticamente quando a cota renovar.`,
          { threadId: proj.threadId }
        ).catch(() => {});
        return;
      }
    }

    // 0b. Aviso automático quando o horário de reset da cota do Claude chegar
    if (run.status === "IDLE" && m.pendingQuotaResetAt && now >= m.pendingQuotaResetAt * 1000) {
      const label = m.quotaNotifiedResetLabel || fmtResetTime(m.pendingQuotaResetAt);
      m.pendingQuotaResetAt = null;
      m.quotaNotifiedResetLabel = null;
      m.lastDiskKey = diskKey;
      await this.refreshCard(projectId, !run.cardMessageId).catch(() => {});
      await this.tg.sendMessage(
        this.chatId,
        `🟢 Cota do Claude renovou (${label}) — ${projectId} já pode ser retomado!`,
        { threadId: proj.threadId }
      ).catch(() => {});
      return;
    }

    // 0c. Detecção de erro de API no .jsonl (não-cota)
    if (run.status === "IDLE" && claudeSession.found && claudeSession.status === "API_ERROR" && claudeSession.apiErrorInfo) {
      const ei = claudeSession.apiErrorInfo;
      if (m.lastNotifiedErrorId !== ei.eventId) {
        m.lastNotifiedErrorId = ei.eventId;
        m.idleAlertSent = true;
        m.turnStopped = true;
        m.lastDiskKey = diskKey;
        await this.refreshCard(projectId, !run.cardMessageId).catch(() => {});
        await this.tg.sendMessage(
          this.chatId,
          `❌ Erro de API no Claude (VS Code) — ${projectId}
Código: ${ei.code}${ei.status ? ` (HTTP ${ei.status})` : ""}
Detalhe: ${ei.rawText.slice(0, 300)}`,
          { threadId: proj.threadId }
        ).catch(() => {});
        return;
      }
    }
    const prevChange = m.lastChangeName;
    const prevPhase = m.lastNotifiedPhase;
    m.lastDiskKey = diskKey;

    if (disk.hasActiveChange) {
      m.lastChangeName = disk.changeName;

      // 1. Nova change surgiu no VS Code após o boot
      if (m.seeded && prevChange !== disk.changeName) {
        m.lastNotifiedPhase = disk.phase;
        if (this.chatId && run.status === "IDLE") {
          await this.refreshCard(projectId, !run.cardMessageId).catch(() => {});
          await this.tg.sendMessage(
            this.chatId,
            `📐 Nova change detectada no VS Code — ${projectId}\nChange: ${disk.changeName}\nFase: ${disk.phase}${disk.risk ? ` | Risco: ${disk.risk.toUpperCase()}` : ""}`,
            { threadId: proj.threadId }
          ).catch(() => {});
        }
        return;
      }

      // 2. Transição de marco importante (pronta para aprovação, homologação, homologada, bloqueada)
      if (m.seeded && disk.phase !== prevPhase && MILESTONE_PHASES.has(disk.phase)) {
        m.lastNotifiedPhase = disk.phase;
        m.idleAlertSent = true;
        if (this.chatId && run.status === "IDLE") {
          await this.refreshCard(projectId, !run.cardMessageId).catch(() => {});
          const tasksLabel = disk.tasks.exists ? `${disk.tasks.done}/${disk.tasks.total} [x]` : "—";
          const icon = disk.phase === "BLOQUEADA" ? "🛑" : (disk.phase === "AGUARDANDO_APROVACAO" ? "📋" : "✅");
          const hint = {
            AGUARDANDO_APROVACAO: "Revise proposal.md/design.md e aprove no VS Code.",
            PRONTA_PARA_HOMOLOGACAO: "Implementação concluída! Você pode homologar no VS Code ou revisar o diff.",
            HOMOLOGADO: "Homologação concluída! Revise o git diff e rode concluir-change no PC.",
            AGUARDANDO_HUMANO: "Cenários automatizados OK — há checklist humano pendente em roteiro-teste.md.",
            BLOQUEADA: "Execução bloqueada no VS Code — confira handoff.md / entrega.md."
          }[disk.phase] || "";

          await this.tg.sendMessage(
            this.chatId,
            `${icon} VS Code atualizou status — ${projectId}\nChange: ${disk.changeName}\nStatus: ${disk.phase}\nTasks: ${tasksLabel} | Arquivos tocados: ${disk.dirtyCount}\n${hint}`,
            { threadId: proj.threadId }
          ).catch(() => {});
        }
        return;
      }

      if (disk.phase !== prevPhase) {
        m.lastNotifiedPhase = disk.phase;
      }
    } else if (prevChange) {
      // Change foi arquivada / concluída no VS Code!
      m.lastChangeName = null;
      m.lastNotifiedPhase = null;
      if (this.chatId && run.status === "IDLE") {
        await this.refreshCard(projectId, false).catch(() => {});
        await this.tg.sendMessage(
          this.chatId,
          `🏁 Change concluída/arquivada no VS Code — ${projectId} (${prevChange}).`,
          { threadId: proj.threadId, silent: true }
        ).catch(() => {});
      }
      return;
    }

    // 3. Atualização silenciosa do Card se houve progresso em tasks/arquivos ou fim de turno
    if ((changed || fromStopEvent) && run.status === "IDLE" && (disk.hasActiveChange || m.lastEventAt > 0)) {
      await this.refreshCard(projectId, !run.cardMessageId).catch(() => {});
    }

    // 4. Watchdog passivo do VS Code: avisa se estava ativo via hooks e ficou em silêncio (esperando interação ou travado)
    if (m.lastEventAt > 0 && !m.turnStopped && !m.idleAlertSent && run.status === "IDLE") {
      const idleSec = Math.round((now - m.lastEventAt) / 1000);
      const limitSec = m.runningLongTool
        ? (Number(this.cfg.defaults.mirrorLongIdleSec) || 360)
        : (Number(this.cfg.defaults.mirrorIdleSec) || 180);
      const isTerminalPhase = disk.hasActiveChange && MILESTONE_PHASES.has(disk.phase);

      if (idleSec >= limitSec && idleSec < limitSec + 600 && !isTerminalPhase) {
        m.idleAlertSent = true;
        const changeLabel = disk.hasActiveChange ? ` (${disk.changeName})` : "";
        const tasksLabel = disk.hasActiveChange && disk.tasks.exists
          ? `\nTasks: ${disk.tasks.done}/${disk.tasks.total} [x]`
          : "";
        await this.refreshCard(projectId, false).catch(() => {});
        await this.tg.sendMessage(
          this.chatId,
          `⏸ VS Code sem novos eventos há ${fmtDuration(idleSec)} em ${projectId}${changeLabel}\nPode estar aguardando sua resposta/confirmação no PC ou travado.\nÚltimo evento: ${m.lastSummary || "—"}${tasksLabel}`,
          {
            threadId: proj.threadId,
            buttons: [[
              { text: "↻ Atualizar", callback_data: `refresh:${projectId}` },
              { text: "📜 Eventos VS Code", callback_data: `logs:${projectId}` }
            ]]
          }
        ).catch(() => {});
      }
    }
  }

  async handleMirrorEvent(ev) {
    const projectId = ev.projectId;
    if (!projectId || !this.cfg.projects[projectId]) return;
    if (this.activeRunners.has(projectId)) return;

    const proj = this.cfg.projects[projectId];
    const run = this.getRun(projectId);
    const m = this.getMirror(projectId);
    const now = Date.now();
    const name = String(ev.eventName || "");
    const agentKey = ev.agentId || ev.agentType || null;
    const desc = formatToolSummary(ev.toolName, ev.toolInput) || name;

    const pushMirrorLog = (line) => {
      m.logLines.push(`[${fmtClock()}] [VSCode] ${String(line).slice(0, 220)}`);
      if (m.logLines.length > 40) m.logLines.shift();
    };

    m.lastEventAt = now;
    m.lastEventName = name;
    m.idleAlertSent = false;

    if (name === "UserPromptSubmit") {
      m.turnStopped = false;
      m.runningLongTool = false;
      m.lastSummary = ev.promptHint ? `Prompt enviado: ${ev.promptHint}` : "Novo prompt enviado no VS Code";
      pushMirrorLog(m.lastSummary);
    } else if (name === "SubagentStart") {
      const id = agentKey || `sub-${now}`;
      m.activeSubagents.set(id, {
        id,
        type: ev.agentType || "subagente",
        startedAt: now,
        lastActivityAt: now,
        lastTool: "iniciado"
      });
      m.turnStopped = false;
      m.lastSummary = `Subagente iniciado: ${ev.agentType || id}`;
      pushMirrorLog(m.lastSummary);
    } else if (name === "SubagentStop") {
      if (agentKey && m.activeSubagents.has(agentKey)) {
        m.activeSubagents.delete(agentKey);
      } else if (m.activeSubagents.size > 0) {
        m.activeSubagents.delete(m.activeSubagents.keys().next().value);
      }
      m.runningLongTool = false;
      m.lastSummary = `Subagente concluído: ${ev.agentType || "subagente"}`;
      pushMirrorLog(m.lastSummary);
    } else if (name === "PreToolUse") {
      m.turnStopped = false;
      m.runningLongTool = ev.toolName === "Bash" || ev.toolName === "Task";
      if (agentKey && m.activeSubagents.has(agentKey)) {
        const s = m.activeSubagents.get(agentKey);
        s.lastActivityAt = now;
        s.lastTool = desc;
      }
      m.lastSummary = `Executando ${desc}`;
      pushMirrorLog(`PreToolUse ${desc}`);
    } else if (name === "PostToolUse") {
      m.turnStopped = false;
      m.runningLongTool = false;
      if (agentKey && m.activeSubagents.has(agentKey)) {
        const s = m.activeSubagents.get(agentKey);
        s.lastActivityAt = now;
        s.lastTool = `OK: ${desc}`;
      }
      m.lastSummary = `OK: ${desc}`;
      pushMirrorLog(`PostToolUse ${desc}`);
    } else if (name === "PermissionRequest") {
      m.turnStopped = false;
      m.idleAlertSent = true;
      m.lastSummary = `Aguardando permissão no VS Code: ${desc}`;
      pushMirrorLog(`PermissionRequest ${desc}`);

      const detail = ev.toolInput && ev.toolInput.command
        ? ev.toolInput.command
        : JSON.stringify(ev.toolInput || {}, null, 2).slice(0, 600);

      await this.refreshCard(projectId, !run.cardMessageId).catch(() => {});
      await this.tg.sendMessage(
        this.chatId,
        `🔐 VS Code aguardando sua permissão — ${projectId}\nFerramenta: ${desc}\nAlvo:\n${detail}\n\n(Aprove ou negue diretamente na tela do VS Code.)`,
        { threadId: proj.threadId }
      ).catch(() => {});
      return;
    } else if (name === "StopFailure") {
      m.turnStopped = true;
      m.runningLongTool = false;
      m.idleAlertSent = true;
      const errBlob = [ev.error, ev.errorDetails, ev.lastAssistantMessage].filter(Boolean).join(" | ");
      const isQuota = /rate.?limit|usage.?limit|hit your .*limit|429/i.test(errBlob);
      m.lastSummary = isQuota
        ? `Cota do Claude atingida (${errBlob.slice(0, 120)})`
        : `Falha no VS Code: ${errBlob || "StopFailure"}`;
      pushMirrorLog(m.lastSummary);

      // Recarrega .jsonl imediatamente para pegar resetsAt exato
      const cs = inspectClaudeSession(proj.path);
      m.claudeSession = cs;
      if (isQuota && cs.found && cs.quotaInfo) {
        m.lastNotifiedQuotaId = cs.quotaInfo.eventId;
        if (cs.quotaInfo.resetsAt) {
          m.pendingQuotaResetAt = cs.quotaInfo.resetsAt;
          m.quotaNotifiedResetLabel = fmtResetTime(cs.quotaInfo.resetsAt);
        }
      }
      const resetNote = (isQuota && cs.found && cs.quotaInfo && cs.quotaInfo.resetsAt)
        ? `\nReset previsto: ${fmtResetTime(cs.quotaInfo.resetsAt)}`
        : "";

      await this.refreshCard(projectId, !run.cardMessageId).catch(() => {});
      await this.tg.sendMessage(
        this.chatId,
        isQuota
          ? `⏳ Cota do Claude atingida no VS Code — ${projectId}${resetNote}\nDetalhe: ${errBlob.slice(0, 260)}`
          : `❌ Falha detectada na sessão VS Code — ${projectId}\nDetalhe: ${errBlob || "StopFailure"}`,
        { threadId: proj.threadId }
      ).catch(() => {});
      return;
    } else if (name === "Stop") {
      m.turnStopped = true;
      m.runningLongTool = false;
      m.activeSubagents.clear();
      m.lastSummary = "Turno concluído no VS Code (aguardando próximo passo)";
      pushMirrorLog("Stop (turno finalizado)");
      await this.pollMirrorProject(projectId, true);
      return;
    } else {
      m.lastSummary = desc;
      pushMirrorLog(`${name}: ${desc}`);
    }

    appendEvent({ type: "mirror", projectId, event: name, tool: ev.toolName, agent: ev.agentType });

    // Aviso curto na primeira atividade detectada da sessão VS Code (cooldown 15 min)
    if (name !== "Stop" && (now - m.sessionNotifiedAt > 15 * 60 * 1000) && run.status === "IDLE") {
      m.sessionNotifiedAt = now;
      m.disk = inspectMainCheckout(proj.path);
      const changeInfo = m.disk && m.disk.hasActiveChange ? `\nChange: ${m.disk.changeName} (${m.disk.phase})` : "";
      await this.tg.sendMessage(
        this.chatId,
        `👀 Sessão ativa no VS Code — ${projectId}${changeInfo}\nAtividade: ${m.lastSummary}`,
        { threadId: proj.threadId }
      ).catch(() => {});
      await this.refreshCard(projectId, true).catch(() => {});
      m.lastCardPushAt = now;
      return;
    }

    // Throttle de atualização silenciosa do card (8s em rajadas, imediato em subagentes)
    const urgentCard = name === "SubagentStart" || name === "SubagentStop";
    if (run.status === "IDLE" && (urgentCard || now - m.lastCardPushAt >= 8000)) {
      m.lastCardPushAt = now;
      m.disk = inspectMainCheckout(proj.path);
      await this.refreshCard(projectId, !run.cardMessageId).catch(() => {});
    }
  }

  async recoverInterruptedRuns() {
    for (const [projectId, run] of Object.entries(this.state.runs || {})) {
      if (run.status !== "RUNNING") continue;
      const alive = run.pid && isPidAlive(run.pid);
      if (alive) continue;

      run.status = "INTERRUPTED";
      run.pid = null;
      run.lastSummary = "Worker reiniciou após queda durante a execução (worktree preservado).";
      this.persist();

      const proj = this.cfg.projects[projectId];
      if (!proj || !this.chatId) continue;
      await this.tg.sendMessage(
        this.chatId,
        `⚠️ Worker reiniciou após queda em ${projectId} (${run.changeName || "change"} · etapa ${run.stage || "?"}).\nO worktree foi preservado em: ${run.worktreePath || "—"}`,
        {
          threadId: proj.threadId,
          buttons: [[
            { text: "▶ Retomar via handoff", callback_data: `resume:${projectId}` },
            { text: "📊 Telemetria", callback_data: `tel:${projectId}` }
          ]]
        }
      ).catch(() => {});
    }
  }

  buildCardText(projectId) {
    const proj = this.cfg.projects[projectId];
    const run = this.getRun(projectId);
    const runner = this.activeRunners.get(projectId);
    const snap = runner ? runner.getSnapshot() : null;

    // --- Visão Modo Espelho (quando worker está ocioso mas há atividade/change no VS Code) ---
    if (!snap && run.status === "IDLE" && proj && fs.existsSync(proj.path)) {
      const m = this.getMirror(projectId);
      const diskWindowSec = Number(this.cfg.defaults.diskActiveWindowSec) || 120;
      const disk = inspectMainCheckout(proj.path, diskWindowSec);
      const cs = inspectClaudeSession(proj.path);
      const agy = inspectAntigravityGlobal(diskWindowSec);
      m.disk = disk;
      m.claudeSession = cs;
      m.antigravityGlobal = agy;

      const now = Date.now();
      const hookIdleSec = m.lastEventAt > 0 ? Math.max(0, Math.round((now - m.lastEventAt) / 1000)) : null;
      const hookLimitSec = m.runningLongTool
        ? (Number(this.cfg.defaults.mirrorLongIdleSec) || 360)
        : (Number(this.cfg.defaults.mirrorIdleSec) || 180);
      const liveClaudeHook = hookIdleSec != null && !m.turnStopped && hookIdleSec <= hookLimitSec;
      const recentClaudeHook = hookIdleSec != null && hookIdleSec < 15 * 60;

      // .jsonl prevalece para cota/erro a menos que um hook mais novo que o registro de cota/erro prove retomada
      const quotaTsMs = (cs.found && cs.quotaInfo && cs.quotaInfo.timestampMs) || 0;
      const errorTsMs = (cs.found && cs.apiErrorInfo && cs.apiErrorInfo.timestampMs) || 0;
      const hookAfterQuota = m.lastEventAt > (quotaTsMs + 1500);
      const hookAfterError = m.lastEventAt > (errorTsMs + 1500);
      const claudeQuotaHit = cs.found && cs.status === "QUOTA_EXHAUSTED" && !hookAfterQuota;
      const claudeQuotaResetReady = cs.found && cs.status === "QUOTA_RESET_READY" && !hookAfterQuota;
      const claudeApiError = cs.found && cs.status === "API_ERROR" && !hookAfterError;
      const liveClaudeJsonl = cs.found && cs.status === "RUNNING";
      const liveDisk = Boolean(disk.diskRecentlyActive);

      const agyPhase = disk.hasActiveChange && ["01-Explorar", "02-Propor", "05-Homologar", "PRONTA_PARA_HOMOLOGACAO", "AGUARDANDO_APROVACAO"].includes(disk.phase);
      const liveAntigravity = Boolean(
        (liveDisk && disk.latestActivity && (disk.latestActivity.kind === "spec" || disk.latestActivity.kind === "qa")) ||
        (agy.recentlyActive && agyPhase && !liveClaudeHook && !liveClaudeJsonl)
      );

      if (claudeQuotaHit || claudeQuotaResetReady || claudeApiError || liveClaudeHook || liveClaudeJsonl || liveAntigravity || liveDisk || disk.hasActiveChange || recentClaudeHook) {
        let statusLine;
        if (claudeQuotaHit) {
          const rStr = cs.quotaInfo && cs.quotaInfo.resetsAt ? ` — reset ${fmtResetTime(cs.quotaInfo.resetsAt)}` : "";
          statusLine = `⏳ PARADO (COTA ESGOTADA${rStr})`;
        } else if (claudeApiError) {
          statusLine = `❌ PARADO (Erro API Claude: ${cs.apiErrorInfo.code})`;
        } else if (liveClaudeHook) {
          statusLine = "🟢 RODANDO (VS Code · hook ao vivo)";
        } else if (liveClaudeJsonl) {
          statusLine = "🟢 RODANDO (VS Code · log da sessão)";
        } else if (liveAntigravity) {
          statusLine = "🟢 RODANDO (VS Code · Antigravity)";
        } else if (liveDisk) {
          statusLine = "🟢 RODANDO (VS Code · atividade em disco)";
        } else if (claudeQuotaResetReady) {
          const rStr = cs.quotaInfo && cs.quotaInfo.resetsAt ? ` às ${fmtResetTime(cs.quotaInfo.resetsAt)}` : "";
          statusLine = `🟡 PARADO (Cota renovou${rStr} · pronto p/ retomar)`;
        } else if (disk.hasActiveChange && disk.phase === "BLOQUEADA") {
          statusLine = "🛑 PARADO (VS Code · BLOQUEADA)";
        } else if (disk.hasActiveChange && disk.phase === "HOMOLOGADO") {
          statusLine = "✅ PARADO (Homologado · rodar concluir-change no PC)";
        } else if (disk.hasActiveChange && disk.phase === "AGUARDANDO_APROVACAO") {
          statusLine = "🟠 PARADO (Aguardando sua aprovação da proposta)";
        } else if (disk.hasActiveChange && disk.phase === "PRONTA_PARA_HOMOLOGACAO") {
          statusLine = "🟡 PARADO (Implementação concluída · falta homologar)";
        } else if (disk.hasActiveChange && disk.phase === "AGUARDANDO_HUMANO") {
          statusLine = "🟡 PARADO (Aguardando validação humana no roteiro)";
        } else if (m.turnStopped && recentClaudeHook) {
          statusLine = "⏸ PARADO (VS Code · turno encerrado)";
        } else {
          statusLine = "⏸ PARADO (VS Code · sem atividade recente)";
        }

        // Identifica claramente qual IA está atuando (Claude vs Gemini/Antigravity)
        let iaLine;
        if (claudeQuotaHit) {
          const lim = cs.quotaInfo ? cs.quotaInfo.limitLabel : "limite de cota";
          iaLine = `IA atual: Claude Code (VS Code · ${lim})`;
        } else if (claudeApiError) {
          iaLine = "IA atual: Claude Code (VS Code · erro de API)";
        } else if (liveClaudeHook) {
          if (m.activeSubagents.size > 0) {
            const subs = Array.from(m.activeSubagents.values());
            const lastSub = subs[subs.length - 1];
            const subElapsed = Math.round((now - lastSub.startedAt) / 1000);
            iaLine = `IA atual: Claude Code (Subagente: ${lastSub.type} · ${fmtDuration(subElapsed)})`;
          } else {
            iaLine = "IA atual: Claude Code (VS Code)";
          }
        } else if (liveClaudeJsonl) {
          iaLine = `IA atual: Claude Code (VS Code${cs.model ? ` · ${cs.model}` : ""})`;
        } else if (liveAntigravity) {
          iaLine = "IA atual: Gemini / Antigravity (VS Code)";
        } else if (liveDisk) {
          const iaName = disk.inferredActiveIa || "Claude Code";
          iaLine = `IA atual: ${iaName} (inferida por escrita recente)`;
        } else if (claudeQuotaResetReady) {
          iaLine = "IA atual: Claude Code (VS Code · cota renovada)";
        } else if (disk.hasActiveChange) {
          iaLine = `IA da etapa: ${disk.ownerIa || "Multi-IA"}`;
        } else {
          iaLine = "IA recente: Claude Code (VS Code)";
        }

        const lines = [
          `📦 ${projectId}${disk.hasActiveChange ? ` · ${disk.changeName}` : ""}`,
          `Status: ${statusLine}`,
          iaLine
        ];

        if (disk.hasActiveChange) {
          const blockPart = disk.tasks && disk.tasks.currentBlock ? ` · ${disk.tasks.currentBlock}` : "";
          const stageName = ((liveClaudeHook || liveClaudeJsonl) && disk.phase === "BLOQUEADA")
            ? "04-Aplicar Change (retomado)"
            : (disk.stageLabel || disk.phase);
          lines.push(`Etapa: ${stageName}${blockPart}`);
          if (disk.tasks && disk.tasks.exists) {
            lines.push(`Tasks: ${disk.tasks.done}/${disk.tasks.total} [x] (${disk.tasks.pct}%)`);
          }
        }

        if (claudeQuotaHit && cs.quotaInfo) {
          const rStr = cs.quotaInfo.resetsAt ? ` (reset ${fmtResetTime(cs.quotaInfo.resetsAt)})` : "";
          lines.push(`Última atividade: há ${fmtDuration(cs.idleSec)} · Cota atingida${rStr}`);
        } else if (liveClaudeHook) {
          lines.push(`Última atividade: há ${fmtDuration(hookIdleSec)} · ${m.lastSummary || "—"}`);
        } else if (liveClaudeJsonl) {
          lines.push(`Última atividade: há ${fmtDuration(cs.idleSec)} · ${cs.lastTool || cs.lastTextSnippet || "processando..."}`);
        } else if (liveAntigravity && agy.found && agy.idleSec != null && (!disk.latestActivity || disk.latestActivity.idleSec == null || agy.idleSec <= disk.latestActivity.idleSec)) {
          lines.push(`Última atividade: há ${fmtDuration(agy.idleSec)} · Antigravity (${agy.sourceFile})`);
        } else if (disk.latestActivity && disk.latestActivity.shortFile && disk.latestActivity.idleSec != null) {
          lines.push(`Última atividade: há ${fmtDuration(disk.latestActivity.idleSec)} · ${disk.latestActivity.shortFile}`);
        } else if (recentClaudeHook) {
          lines.push(`Última atividade: há ${fmtDuration(hookIdleSec)} · ${m.lastSummary || "—"}`);
        }

        const riskPart = disk.risk ? ` | Risco: ${disk.risk.toUpperCase()}` : "";
        lines.push(`Checkout (${disk.branch}): ${disk.dirtyCount} arq. tocado(s)${riskPart}`);
        lines.push(`Verificado às ${fmtClock()}`);
        return lines.join("\n");
      }
    }

    // --- Visão Padrão do Worker (execução gerenciada pelo Telegram) ---
    const statusIcon = {
      IDLE: "⚪ PARADO (OCIOSO)",
      RUNNING: "🟢 RODANDO (Worker)",
      WAITING_USER_INPUT: "🟡 PARADO (Aguardando sua resposta)",
      WAITING_APPROVAL: "🟠 PARADO (Aguardando aprovação)",
      WAITING_PC_APPROVAL: "🔴 PARADO (Risco HIGH — revisar no PC)",
      PAUSED: "⏸ PARADO (Pausado)",
      PAUSED_QUOTA: "⏳ PARADO (Cota esgotada)",
      INTERRUPTED: "⚠️ PARADO (Interrompido)",
      PRONTO_REVISAO: "✅ PARADO (Pronto para revisão no PC)",
      BLOCKED: "🛑 PARADO (Bloqueado)"
    }[run.status] || run.status;

    const lines = [
      `📦 ${projectId}${run.changeName ? ` · ${run.changeName}` : ""}`,
      `Status: ${statusIcon}`
    ];

    if (snap) {
      const pidLabel = snap.pid ? `PID ${snap.pid} (${snap.alive ? "vivo" : "morto"})` : "sem PID";
      const iaBase = run.iaLabel || (snap.kind === "claude" ? "Claude CLI" : "Gemini / Antigravity CLI");
      const subSuffix = snap.subagents.length > 0
        ? ` · Subagente: ${snap.subagents[snap.subagents.length - 1].type}`
        : "";
      lines.push(`IA atual: ${iaBase}${subSuffix} | ${pidLabel}`);
      if (run.stage) lines.push(`Etapa: ${run.stage} (${fmtDuration(snap.elapsedSec)})`);
      lines.push(`Última atividade: há ${fmtDuration(snap.idleSec)} · ${snap.lastSummary}`);
    } else {
      if (run.iaLabel) lines.push(`Última IA: ${run.iaLabel}`);
      if (run.stage) lines.push(`Etapa: ${run.stage}`);
      lines.push(`Resumo: ${run.lastSummary || "Sem atividade"}`);
    }

    if (run.worktreePath && fs.existsSync(run.worktreePath)) {
      if (run.changeName) {
        const wtTasks = parseTasksProgress(path.join(run.worktreePath, "openspec", "changes", run.changeName, "tasks.md"));
        if (wtTasks.exists) {
          const blk = wtTasks.currentBlock ? ` · ${wtTasks.currentBlock}` : "";
          lines.push(`Tasks: ${wtTasks.done}/${wtTasks.total} [x] (${wtTasks.pct}%)${blk}`);
        }
      }
      const dirty = listDirtyFiles(run.worktreePath).length;
      lines.push(`Worktree: ${run.branchName || "—"} (${dirty} arq. tocado(s))`);
    }

    if (run.risk) {
      lines.push(`Risco: ${run.risk.toUpperCase()}${run.pcApprovedHighRisk ? " (aprovado no PC)" : ""}`);
    }

    const rl = (snap && snap.rateLimit) || run.rateLimit;
    if (rl && (rl.fiveHourPct != null || rl.sevenDayPct != null)) {
      const reset = rl.resetsAt ? ` · reset ${fmtResetTime(rl.resetsAt)}` : "";
      lines.push(`Cota Claude: 5h ${rl.fiveHourPct ?? "?"}% | 7d ${rl.sevenDayPct ?? "?"}%${reset}`);
    }

    if (proj && fs.existsSync(proj.path)) {
      const manual = detectManualSession(proj.path);
      if (manual.dirtyCount > 0) {
        lines.push(`Checkout principal (VS Code): ${manual.dirtyCount} arq. modificado(s)`);
      }
    }

    lines.push(`Verificado às ${fmtClock()}`);
    return lines.join("\n");
  }

  buildCardButtons(projectId) {
    const run = this.getRun(projectId);
    const isRunning = this.activeRunners.has(projectId);
    if (isRunning) {
      return [
        [
          { text: "↻ Atualizar", callback_data: `refresh:${projectId}` },
          { text: "📜 Últimas linhas", callback_data: `logs:${projectId}` }
        ],
        [
          { text: "⏸ Pausar após etapa", callback_data: `pause:${projectId}` },
          { text: "⛔ Abortar", callback_data: `abort:${projectId}` }
        ]
      ];
    }
    const row1 = [
      { text: "↻ Atualizar", callback_data: `refresh:${projectId}` },
      { text: "📊 Telemetria", callback_data: `tel:${projectId}` }
    ];
    if (run.status === "INTERRUPTED" || run.status === "PAUSED" || run.status === "PAUSED_QUOTA" || run.status === "BLOCKED") {
      return [row1, [{ text: "▶ Retomar via handoff", callback_data: `resume:${projectId}` }]];
    }
    const m = this.getMirror(projectId);
    if (m.logLines.length > 0) {
      return [row1, [{ text: "📜 Eventos VS Code", callback_data: `logs:${projectId}` }]];
    }
    return [row1];
  }

  async refreshCard(projectId, forceNew = false) {
    const proj = this.cfg.projects[projectId];
    if (!proj || !this.chatId) return;
    const run = this.getRun(projectId);
    const text = this.buildCardText(projectId);
    const buttons = this.buildCardButtons(projectId);

    if (run.cardMessageId && !forceNew) {
      try {
        await this.tg.editMessageText(this.chatId, run.cardMessageId, text, { buttons });
        return;
      } catch (_) {}
    }

    const previousCardId = run.cardMessageId;
    const msg = await this.tg.sendMessage(this.chatId, text, {
      threadId: proj.threadId,
      silent: true,
      buttons
    });
    if (msg && msg.message_id) {
      run.cardMessageId = msg.message_id;
      this.persist();
      await this.tg.pinMessage(this.chatId, msg.message_id);
      if (previousCardId && Number(previousCardId) !== Number(msg.message_id)) {
        await this.tg.deleteMessage(this.chatId, previousCardId).catch(() => {});
      }
    }
  }

  handleHookTelemetry(ev) {
    const projectId = ev.projectId;
    if (!projectId) return;
    const runner = this.activeRunners.get(projectId);
    if (runner) {
      runner.handleHookEvent(ev);
    }
    appendEvent({ type: "hook", projectId, event: ev.eventName, tool: ev.toolName, agent: ev.agentType });
  }

  async handlePermissionRequest(reqId, ev) {
    const projectId = ev.projectId;
    const proj = this.cfg.projects[projectId];
    if (!proj || !this.chatId) {
      this.hookServer.resolvePermission(reqId, "deny", "Projeto não mapeado no worker.");
      return;
    }

    const runner = this.activeRunners.get(projectId);
    if (runner) {
      runner.snoozeStall(this.cfg.defaults.permissionTimeoutMin || 15);
    }

    const summary = formatToolSummary(ev.toolName, ev.toolInput);
    const detail = ev.toolInput && ev.toolInput.command
      ? ev.toolInput.command
      : JSON.stringify(ev.toolInput || {}, null, 2).slice(0, 700);

    const text = [
      `🔐 Permissão necessária — ${projectId}`,
      `Ferramenta: ${summary || ev.toolName || "desconhecida"}`,
      `Comando/alvo:\n${detail}`,
      `Timeout fail-closed: ${this.cfg.defaults.permissionTimeoutMin || 15} min (nega automaticamente se expirar).`
    ].join("\n\n");

    const msg = await this.tg.sendMessage(this.chatId, text, {
      threadId: proj.threadId,
      buttons: [[
        { text: "✅ Permitir 1x", callback_data: `perm:allow:${reqId}` },
        { text: "❌ Negar", callback_data: `perm:deny:${reqId}` }
      ]]
    });

    this.pendingPermsMeta.set(reqId, {
      projectId,
      chatId: this.chatId,
      threadId: proj.threadId,
      messageId: msg ? msg.message_id : null,
      summary
    });
  }

  async handleTelegramUpdate(update) {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    if (update.message) {
      await this.handleMessage(update.message);
    }
  }

  isAuthorized(fromId, chatId) {
    if (!fromId || Number(fromId) !== this.allowedUserId) return false;
    if (this.chatId && Number(chatId) !== Number(this.chatId)) return false;
    return true;
  }

  async handleMessage(msg) {
    const fromId = msg.from && msg.from.id;
    const chatId = msg.chat && msg.chat.id;
    if (!this.isAuthorized(fromId, chatId)) return;

    const text = String(msg.text || "").trim();
    if (!text) return;

    const threadId = msg.message_thread_id != null ? Number(msg.message_thread_id) : null;
    const proj = findProjectByThread(this.cfg, threadId);

    if (!text.startsWith("/")) {
      if (proj) {
        const run = this.getRun(proj.id);
        if (run.status === "WAITING_USER_INPUT") {
          await this.continueExploreWithAnswer(proj, text);
        }
      }
      return;
    }

    const parts = text.split(/\s+/);
    const cmd = parts[0].split("@")[0].toLowerCase();
    const arg = parts.slice(1).join(" ").trim();

    if (cmd === "/ajuda" || cmd === "/start") {
      await this.tg.sendMessage(chatId, this.helpText(proj), { threadId, silent: true });
      return;
    }

    if (!proj) {
      if (cmd === "/status") {
        const lines = ["📊 Painel Geral — AI-Kit Worker v2.2.5"];
        const diskWindowSec = Number(this.cfg.defaults.diskActiveWindowSec) || 120;
        for (const [id, p] of Object.entries(this.cfg.projects || {})) {
          const r = this.getRun(id);
          if (this.activeRunners.has(id) || r.status !== "IDLE") {
            const running = this.activeRunners.has(id);
            const tag = running ? "🟢 RODANDO" : `⏸ PARADO (${r.status})`;
            lines.push(`• ${id}: ${tag} | ${r.iaLabel || "Worker"} | ${r.stage || "—"}`);
          } else {
            const m = this.getMirror(id);
            const disk = fs.existsSync(p.path) ? inspectMainCheckout(p.path, diskWindowSec) : { hasActiveChange: false };
            const cs = fs.existsSync(p.path) ? inspectClaudeSession(p.path) : { found: false };
            const agy = inspectAntigravityGlobal(diskWindowSec);
            const liveHook = m.lastEventAt > 0 && (Date.now() - m.lastEventAt) < 180000 && !m.turnStopped;
            const liveJsonl = cs.found && cs.status === "RUNNING";
            const quotaTs = (cs.found && cs.quotaInfo && cs.quotaInfo.timestampMs) || 0;
            const quotaHit = cs.found && cs.status === "QUOTA_EXHAUSTED" && !(m.lastEventAt > quotaTs + 1500);
            const liveDisk = Boolean(disk.diskRecentlyActive);
            if (quotaHit) {
              const rStr = cs.quotaInfo && cs.quotaInfo.resetsAt ? ` reset ${fmtResetTime(cs.quotaInfo.resetsAt)}` : "";
              const tInfo = disk.hasActiveChange && disk.tasks.exists ? ` · ${disk.tasks.done}/${disk.tasks.total} (${disk.tasks.pct}%)` : "";
              lines.push(`• ${id}: ⏳ COTA ESGOTADA (${rStr.trim() || "Claude"}) | ${disk.stageLabel || disk.phase || "VS Code"}${tInfo}`);
            } else if (liveHook || liveJsonl || liveDisk || disk.hasActiveChange) {
              const running = liveHook || liveJsonl || liveDisk;
              const stateTag = running ? "🟢 RODANDO" : "⏸ PARADO";
              const iaTag = (liveHook || liveJsonl) ? "Claude" : (liveDisk ? (disk.inferredActiveIa || (agy.recentlyActive ? "Antigravity" : "Claude")) : (disk.ownerIa || "Multi-IA"));
              const tInfo = disk.hasActiveChange && disk.tasks.exists ? ` · ${disk.tasks.done}/${disk.tasks.total} (${disk.tasks.pct}%)` : "";
              lines.push(`• ${id}: ${stateTag} (VS Code) | ${iaTag} | ${disk.stageLabel || disk.phase || "ativo"}${tInfo}`);
            } else {
              lines.push(`• ${id}: ⚪ PARADO (ocioso)`);
            }
          }
        }
        await this.tg.sendMessage(chatId, lines.join("\n"), { threadId, silent: true });
        return;
      }
      await this.tg.sendMessage(
        chatId,
        "Este tópico não está vinculado a nenhum projeto. Use um tópico de projeto ou rode `ai-kit worker setup-telegram` no PC.",
        { threadId, silent: true }
      );
      return;
    }

    if (cmd === "/status") {
      await this.refreshCard(proj.id, true);
      return;
    }
    if (cmd === "/fila") {
      const slices = listPendingSlices(proj.path);
      const body = slices.length > 0
        ? `📋 Próximas fatias em ${proj.id}:\n\n${slices.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nUse: /iniciar <slug> ou /explorar <slug>`
        : `Nenhuma fatia pendente encontrada em ${proj.id} (confira docs/fila ou docs/plano.md).`;
      await this.tg.sendMessage(chatId, body, { threadId, silent: true });
      return;
    }
    if (cmd === "/telemetria") return this.sendTelemetry(proj);
    if (cmd === "/logs") return this.sendLogs(proj);
    if (cmd === "/pausar") {
      const run = this.getRun(proj.id);
      run.pauseRequested = true;
      this.persist();
      await this.tg.sendMessage(chatId, `⏸ Pausa agendada em ${proj.id}: o fluxo vai estacionar ao fim da etapa atual.`, { threadId, silent: true });
      return;
    }
    if (cmd === "/abortar") return this.abortProject(proj);
    if (cmd === "/explorar") {
      if (!arg) {
        await this.tg.sendMessage(chatId, "Informe o slug da change: `/explorar <slug>`", { threadId });
        return;
      }
      return this.startExplore(proj, arg);
    }
    if (cmd === "/propor" || cmd === "/iniciar") {
      if (!arg) {
        await this.tg.sendMessage(chatId, "Informe o slug da change: `/iniciar <slug>`", { threadId });
        return;
      }
      return this.startPropose(proj, arg);
    }
    if (cmd === "/homologar") return this.startHomologar(proj);
    if (cmd === "/retomar") return this.resumeProject(proj);

    await this.tg.sendMessage(chatId, `Comando não reconhecido: ${cmd}. Use /ajuda.`, { threadId, silent: true });
  }

  async handleCallback(cb) {
    const fromId = cb.from && cb.from.id;
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    if (!this.isAuthorized(fromId, chatId)) {
      await this.tg.answerCallback(cb.id, "Não autorizado.", true);
      return;
    }

    const data = String(cb.data || "");
    const [action, p1, p2] = data.split(":");

    if (action === "perm") {
      const decision = p1 === "allow" ? "allow" : "deny";
      const reqId = p2;
      const resolved = this.hookServer.resolvePermission(reqId, decision);
      const meta = this.pendingPermsMeta.get(reqId);
      this.pendingPermsMeta.delete(reqId);
      await this.tg.answerCallback(cb.id, resolved ? (decision === "allow" ? "Permitido 1x" : "Negado") : "Solicitação já expirou.");
      if (meta && meta.messageId) {
        const mark = decision === "allow" ? "✅ PERMITIDO (1x)" : "❌ NEGADO";
        await this.tg.editMessageText(
          meta.chatId,
          meta.messageId,
          `${mark} às ${fmtClock()}\nFerramenta: ${meta.summary || "comando"}`,
          { buttons: [] }
        ).catch(() => {});
      }
      return;
    }

    const projectId = p1;
    const rawProj = this.cfg.projects[projectId];
    if (!rawProj) {
      await this.tg.answerCallback(cb.id, "Projeto não encontrado.", true);
      return;
    }
    const proj = { id: projectId, ...rawProj };

    if (action === "refresh") {
      const run = this.getRun(projectId);
      const clickedMsgId = cb.message && cb.message.message_id;
      const isCurrentCard = Boolean(run.cardMessageId && clickedMsgId && Number(run.cardMessageId) === Number(clickedMsgId));
      await this.refreshCard(projectId, !isCurrentCard);
      await this.tg.answerCallback(cb.id, isCurrentCard ? `Card atualizado às ${fmtClock()}` : `Novo Card enviado às ${fmtClock()}`);
      return;
    }
    if (action === "logs") {
      await this.tg.answerCallback(cb.id, "Enviando últimas linhas...");
      await this.sendLogs(proj);
      return;
    }
    if (action === "snooze") {
      const runner = this.activeRunners.get(projectId);
      if (runner) runner.snoozeStall(5);
      await this.tg.answerCallback(cb.id, "Watchdog adiado +5 min");
      return;
    }
    if (action === "pause") {
      const run = this.getRun(projectId);
      run.pauseRequested = true;
      this.persist();
      await this.tg.answerCallback(cb.id, "Vai pausar após a etapa atual");
      return;
    }
    if (action === "abort") {
      await this.tg.answerCallback(cb.id, "Abortando processo...");
      await this.abortProject(proj);
      return;
    }
    if (action === "tel") {
      await this.tg.answerCallback(cb.id, "Coletando telemetria...");
      await this.sendTelemetry(proj);
      return;
    }
    if (action === "resume") {
      await this.tg.answerCallback(cb.id, "Retomando...");
      await this.resumeProject(proj);
      return;
    }
    if (action === "approve") {
      const run = this.getRun(projectId);
      if (run.status !== "WAITING_APPROVAL") {
        await this.tg.answerCallback(cb.id, "Esta proposta não está aguardando aprovação mobile.", true);
        return;
      }
      if (run.risk === "high" && !run.pcApprovedHighRisk) {
        await this.tg.answerCallback(cb.id, "Bloqueado: risco ALTO exige aprovação no PC.", true);
        return;
      }
      await this.tg.answerCallback(cb.id, "Spec aprovada! Iniciando /aplicar-change...");
      await this.runApplyAndQaPipeline(proj);
      return;
    }
    if (action === "propose_from_explore") {
      const run = this.getRun(projectId);
      await this.tg.answerCallback(cb.id, "Iniciando openspec-propose...");
      await this.startPropose(proj, run.changeName || "");
      return;
    }
    if (action === "reject") {
      const run = this.getRun(projectId);
      run.status = "PAUSED";
      run.lastSummary = "Proposta pausada pelo usuário no celular (worktree preservado).";
      this.persist();
      await this.tg.answerCallback(cb.id, "Proposta pausada.");
      await this.refreshCard(projectId, false);
    }
  }

  helpText(proj) {
    const scope = proj ? `Projeto do tópico: ${proj.id} (${proj.path})` : "Tópico Geral";
    return [
      `🤖 AI-Kit Worker v2.2.5 — ${scope}`,
      "",
      "/status — Força atualização ao vivo do Card (Worker ou VS Code espelhado)",
      "/fila — Lista próximas fatias pendentes",
      "/explorar <slug> — Roda openspec-explore (você responde em texto livre no tópico)",
      "/iniciar <slug> — Cria worktree, propõe + revisa spec (pausa para OK)",
      "/homologar — Roda homologar-change + telemetria determinística",
      "/telemetria — Roda ai-kit telemetry (worktree ou checkout principal)",
      "/logs — Últimas 25 linhas do agente (Worker ou VS Code)",
      "/pausar · /retomar · /abortar",
      "",
      "Modo Espelho ativo: sessões iniciadas no VS Code aparecem automaticamente no Card e avisam quando precisarem de você ou concluírem."
    ].join("\n");
  }

  async sendLogs(proj) {
    const runner = this.activeRunners.get(proj.id);
    if (runner && runner.logLines.length > 0) {
      const lines = runner.logLines.slice(-25);
      await this.tg.sendMessage(
        this.chatId,
        `📜 Últimas ${lines.length} linhas (Worker) — ${proj.id}:\n\n${lines.join("\n")}`,
        { threadId: proj.threadId, silent: true }
      );
      return;
    }
    const m = this.getMirror(proj.id);
    if (m.logLines.length > 0) {
      const lines = m.logLines.slice(-25);
      await this.tg.sendMessage(
        this.chatId,
        `📜 Últimos ${lines.length} eventos (VS Code espelhado) — ${proj.id}:\n\n${lines.join("\n")}`,
        { threadId: proj.threadId, silent: true }
      );
      return;
    }
    await this.tg.sendMessage(
      this.chatId,
      `Sem eventos recentes registrados em ${proj.id}.`,
      { threadId: proj.threadId, silent: true }
    );
  }

  async sendTelemetry(proj) {
    const run = this.getRun(proj.id);
    const target = (run.worktreePath && fs.existsSync(run.worktreePath)) ? run.worktreePath : proj.path;
    const t = collectTelemetry(target);
    if (!t.isGit) {
      await this.tg.sendMessage(this.chatId, `⚠️ ${t.error}`, { threadId: proj.threadId });
      return;
    }
    const alerts = t.testIntegrity.alerts.length ? `\nAlertas: ${t.testIntegrity.alerts.join("; ")}` : "";
    const text = [
      `📊 Telemetria — ${proj.id} (${path.basename(target)})`,
      `Branch: ${t.branch} @ ${t.head}`,
      `Diff_Hash: ${t.diffHash}`,
      `Test_integrity: ${t.testIntegrity.ok ? "✅ OK" : "🚨 ALERTA"} (assertions +${t.testIntegrity.addedAssertions}/-${t.testIntegrity.removedAssertions})${alerts}`,
      `Sensitive_touched: ${t.sensitiveTouched.length ? t.sensitiveTouched.join(", ") : "nenhum"}`,
      `Risco: ${t.riskEscalation}`,
      `Diff stat:\n${t.diffStat}`
    ].join("\n");
    await this.tg.sendMessage(this.chatId, text, { threadId: proj.threadId, silent: true });
  }

  async abortProject(proj) {
    const runner = this.activeRunners.get(proj.id);
    const run = this.getRun(proj.id);
    if (runner) {
      runner.abort();
      this.activeRunners.delete(proj.id);
    }
    run.status = "PAUSED";
    run.pid = null;
    run.lastSummary = "Abortado manualmente pelo usuário (worktree preservado).";
    this.persist();
    await this.refreshCard(proj.id, false);
    await this.tg.sendMessage(
      this.chatId,
      `⛔ Execução abortada em ${proj.id}. Worktree preservado em: ${run.worktreePath || "—"}`,
      { threadId: proj.threadId }
    );
  }

  async executeRunner(proj, opts) {
    const run = this.getRun(proj.id);
    if (this.activeRunners.has(proj.id)) {
      throw new Error(`Já existe uma execução ativa em ${proj.id}. Use /status ou /abortar.`);
    }

    const runId = crypto.randomBytes(4).toString("hex");
    const env = opts.kind === "claude"
      ? {
          AI_KIT_WORKER_URL: this.hookServer.url,
          AI_KIT_WORKER_TOKEN: this.hookServer.token,
          AI_KIT_PROJECT_ID: proj.id,
          AI_KIT_RUN_ID: runId
        }
      : {};

    const runner = new AgentRunner({
      kind: opts.kind,
      bin: opts.kind === "claude" ? this.cfg.defaults.claudeBin : this.cfg.defaults.agyBin,
      args: opts.args,
      cwd: run.worktreePath,
      env,
      stallCodeSec: proj.stallCodeSec || this.cfg.defaults.stallCodeSec,
      stallTestSec: proj.stallTestSec || this.cfg.defaults.stallTestSec,
      hardTimeoutMin: proj.stageTimeoutMin || this.cfg.defaults.stageTimeoutMin,
      onQuota: (rl) => {
        run.rateLimit = rl;
        this.persist();
      },
      onStall: async (snap, limitSec) => {
        const subInfo = snap.subagents.length > 0
          ? `\nSubagente ativo: ${snap.subagents[snap.subagents.length - 1].type} (${snap.subagents[snap.subagents.length - 1].lastTool})`
          : "";
        await this.tg.sendMessage(
          this.chatId,
          `⚠️ Possível travamento em ${proj.id} (${run.stage})\nPID ${snap.pid} (${snap.alive ? "vivo" : "morto"}) sem saída há ${fmtDuration(snap.idleSec)} (limite ${fmtDuration(limitSec)}).${subInfo}\nÚltimo evento: ${snap.lastSummary}`,
          {
            threadId: proj.threadId,
            buttons: [[
              { text: "📜 Últimas linhas", callback_data: `logs:${proj.id}` },
              { text: "⏳ +5 min", callback_data: `snooze:${proj.id}` },
              { text: "⛔ Abortar", callback_data: `abort:${proj.id}` }
            ]]
          }
        ).catch(() => {});
      }
    });

    this.activeRunners.set(proj.id, runner);
    run.status = "RUNNING";
    run.stage = opts.stageLabel;
    run.iaLabel = opts.iaLabel;
    run.pauseRequested = false;
    run.lastSummary = `Iniciando ${opts.stageLabel}...`;
    this.persist();

    await this.tg.sendMessage(
      this.chatId,
      `🚀 Iniciado: ${opts.stageLabel} em ${proj.id}\nChange: ${run.changeName}\nIA: ${opts.iaLabel}`,
      { threadId: proj.threadId }
    );
    await this.refreshCard(proj.id, !run.cardMessageId);

    const startPromise = runner.start();
    setTimeout(() => {
      if (runner.pid) {
        run.pid = runner.pid;
        this.persist();
        this.refreshCard(proj.id, false).catch(() => {});
      }
    }, 600);

    const result = await startPromise;
    this.activeRunners.delete(proj.id);
    run.pid = null;
    if (result.rateLimit) run.rateLimit = result.rateLimit;
    this.persist();

    appendEvent({
      type: "stage_done",
      projectId: proj.id,
      change: run.changeName,
      stage: opts.stageLabel,
      exitCode: result.exitCode,
      quotaHit: result.quotaHit,
      authError: result.authError
    });

    return result;
  }

  async prepareWorktree(proj, slugInput) {
    const run = this.getRun(proj.id);
    const changeName = buildChangeName(slugInput);
    const wt = ensureWorktree(proj.path, changeName);
    run.changeName = changeName;
    run.worktreePath = wt.worktreePath;
    run.branchName = wt.branchName;
    run.pcApprovedHighRisk = false;
    this.persist();
    return { run, wt };
  }

  async startExplore(proj, slugInput) {
    try {
      const { run } = await this.prepareWorktree(proj, slugInput);
      const prompt = [
        `Execute a skill .agent/skills/openspec-explore/SKILL.md para a change "${run.changeName}".`,
        "Leia .ai/project.yaml e apenas os arquivos relevantes. Não edite código de aplicação.",
        `Ao final, escreva openspec/changes/${run.changeName}/exploracao.md e liste objetivamente qualquer pergunta bloqueante para o usuário responder.`
      ].join("\n");

      const args = buildAgyArgs(prompt, "explore", this.cfg.defaults, { ...proj, agyLogFile: path.join(WORKER_HOME, "logs", `agy-${proj.id}.log`) });
      const res = await this.executeRunner(proj, {
        kind: "agy",
        args,
        stageLabel: "01-Explorar",
        iaLabel: "Antigravity CLI (T1 · high)"
      });

      await this.handleExploreResult(proj, res);
    } catch (err) {
      await this.tg.sendMessage(this.chatId, `❌ Erro ao iniciar exploração: ${err.message}`, { threadId: proj.threadId });
    }
  }

  async continueExploreWithAnswer(proj, userAnswer) {
    const run = this.getRun(proj.id);
    const prompt = [
      `Continue a skill .agent/skills/openspec-explore/SKILL.md na change "${run.changeName}".`,
      "Resposta do usuário às dúvidas anteriores:",
      "---",
      userAnswer,
      "---",
      "Atualize exploracao.md e handoff.md. Não edite código de aplicação. Informe se já está pronto para openspec-propose ou se ainda há dúvida bloqueante."
    ].join("\n");

    const args = buildAgyArgs(prompt, "explore", this.cfg.defaults, { ...proj, agyLogFile: path.join(WORKER_HOME, "logs", `agy-${proj.id}.log`) });
    const res = await this.executeRunner(proj, {
      kind: "agy",
      args,
      stageLabel: "01-Explorar (rodada)",
      iaLabel: "Antigravity CLI (T1 · high)"
    });
    await this.handleExploreResult(proj, res);
  }

  async handleExploreResult(proj, res) {
    const run = this.getRun(proj.id);
    if (await this.handleCommonFailure(proj, res)) return;

    const boundary = auditBoundary(run.worktreePath, "explore");
    if (!boundary.ok) {
      run.status = "BLOCKED";
      run.lastSummary = `Violação de fronteira no explore: ${boundary.violations.join(", ")}`;
      this.persist();
      await this.refreshCard(proj.id, false);
      await this.tg.sendMessage(
        this.chatId,
        `🚨 Violação de fronteira em ${proj.id}: o planejador tocou arquivos fora de openspec/docs:\n${boundary.violations.join("\n")}`,
        { threadId: proj.threadId }
      );
      return;
    }

    run.status = "WAITING_USER_INPUT";
    run.lastSummary = "Exploração concluída — responda no tópico ou avance para Propor.";
    this.persist();
    await this.refreshCard(proj.id, false);

    const snippet = res.finalText || readHandoffSnippet(run.worktreePath, run.changeName) || res.logTail.slice(-10).join("\n");
    await this.tg.sendMessage(
      this.chatId,
      `🧭 Exploração concluída (${run.changeName}):\n\n${snippet.slice(0, 2600)}\n\n💬 Responda em texto aqui se houver dúvidas, ou toque abaixo para montar a proposta:`,
      {
        threadId: proj.threadId,
        buttons: [[
          { text: "📐 Gerar Proposta (propose + revisão)", callback_data: `propose_from_explore:${proj.id}` },
          { text: "⏸ Pausar", callback_data: `reject:${proj.id}` }
        ]]
      }
    );
  }

  async startPropose(proj, slugInput) {
    try {
      const { run } = await this.prepareWorktree(proj, slugInput);
      const prompt = [
        `Execute a skill .agent/skills/openspec-propose/SKILL.md para a change "${run.changeName}".`,
        "Inclua obrigatoriamente o frontmatter YAML de risco (risk: low | medium | high, needs_explore, sensitive_paths) em proposal.md.",
        "Gere design.md com critérios de aceite travados, delta specs e tasks.md em Blocos Atômicos + Verificação.",
        "Em seguida execute a revisão read-only (.agent/skills/revisar-proposta/SKILL.md) gravando revisao-proposta.md e atualizando handoff.md.",
        "NUNCA edite código de aplicação."
      ].join("\n");

      const args = buildAgyArgs(prompt, "propose", this.cfg.defaults, { ...proj, agyLogFile: path.join(WORKER_HOME, "logs", `agy-${proj.id}.log`) });
      const res = await this.executeRunner(proj, {
        kind: "agy",
        args,
        stageLabel: "02-Propor + Revisar",
        iaLabel: "Antigravity CLI (T1 · high)"
      });

      if (await this.handleCommonFailure(proj, res)) return;

      const boundary = auditBoundary(run.worktreePath, "propose");
      if (!boundary.ok) {
        run.status = "BLOCKED";
        run.lastSummary = `Violação de fronteira no propose: ${boundary.violations.join(", ")}`;
        this.persist();
        await this.refreshCard(proj.id, false);
        await this.tg.sendMessage(
          this.chatId,
          `🚨 Violação de fronteira em ${proj.id}: o planejador alterou código de aplicação durante propose:\n${boundary.violations.join("\n")}`,
          { threadId: proj.threadId }
        );
        return;
      }

      const riskInfo = parseProposalRisk(run.worktreePath, run.changeName);
      const reviewInfo = parseReviewReport(run.worktreePath, run.changeName);
      run.risk = riskInfo.risk;

      const hasBlockers = reviewInfo.blockers == null || reviewInfo.blockers > 0 || !reviewInfo.validateOk;

      if (riskInfo.risk === "high") {
        run.status = "WAITING_PC_APPROVAL";
        run.lastSummary = "Risco HIGH: aprovação pelo celular desabilitada (revisar no PC).";
        this.persist();
        await this.refreshCard(proj.id, false);
        await this.tg.sendMessage(
          this.chatId,
          `🔴 PROPOSTA DE RISCO ALTO (${run.changeName})\nAprovação pelo celular está DESABILITADA por política anti-vibe-coding.\n\nRevisão: ${reviewInfo.summary}\nWorktree: ${run.worktreePath}\n\nRevise proposal.md/design.md no monitor e, se aprovado, rode no PowerShell:\nai-kit worker approve ${proj.id}`,
          { threadId: proj.threadId }
        );
        return;
      }

      if (hasBlockers) {
        run.status = "BLOCKED";
        run.lastSummary = `Revisão encontrou bloqueantes (${reviewInfo.blockers ?? "?"}).`;
        this.persist();
        await this.refreshCard(proj.id, false);
        await this.tg.sendMessage(
          this.chatId,
          `🛑 Proposta bloqueada na revisão (${run.changeName}):\n\n${reviewInfo.summary}\n\nCorrija via openspec-update-change ou revise no PC.`,
          { threadId: proj.threadId }
        );
        return;
      }

      run.status = "WAITING_APPROVAL";
      run.lastSummary = `Proposta revisada (risk=${riskInfo.risk}, 0 bloqueantes) — aguardando OK.`;
      this.persist();
      await this.refreshCard(proj.id, false);

      const handoff = readHandoffSnippet(run.worktreePath, run.changeName) || reviewInfo.summary;
      await this.tg.sendMessage(
        this.chatId,
        `📋 Proposta pronta para aprovação (${run.changeName})\nRisco: ${riskInfo.risk.toUpperCase()} | Bloqueantes: 0 | openspec validate: OK\n\n${handoff.slice(0, 2200)}`,
        {
          threadId: proj.threadId,
          buttons: [[
            { text: "✅ Aprovar Spec e Implementar", callback_data: `approve:${proj.id}` },
            { text: "⏸ Pausar", callback_data: `reject:${proj.id}` }
          ]]
        }
      );
    } catch (err) {
      await this.tg.sendMessage(this.chatId, `❌ Erro no propose: ${err.message}`, { threadId: proj.threadId });
    }
  }

  async runApplyAndQaPipeline(proj) {
    const run = this.getRun(proj.id);
    if (!run.changeName || !run.worktreePath) {
      await this.tg.sendMessage(this.chatId, "Nenhuma change ativa para aplicar.", { threadId: proj.threadId });
      return;
    }

    const prompt = [
      `Execute a skill .claude/skills/aplicar-change/SKILL.md para a change "${run.changeName}".`,
      "A proposta está formalmente APROVADO PARA IMPLEMENTAÇÃO pelo usuário.",
      "Execute bloco a bloco via subagente implementar-bloco + rodar-testes + ai-kit telemetry, gere entrega.md (com Diff_Hash) e atualize handoff.md.",
      "NUNCA faça commit, push ou archive."
    ].join("\n");

    const args = buildClaudeArgs(prompt, this.cfg.defaults, proj);
    const res = await this.executeRunner(proj, {
      kind: "claude",
      args,
      stageLabel: "04-Aplicar Change",
      iaLabel: "Claude CLI (Sonnet · T2)"
    });

    if (await this.handleCommonFailure(proj, res)) return;

    const tel = collectTelemetry(run.worktreePath);
    if (!tel.isGit || !tel.testIntegrity.ok) {
      run.status = "BLOCKED";
      run.lastSummary = `Telemetria acusou violação de integridade de testes: ${(tel.testIntegrity && tel.testIntegrity.alerts || []).join("; ")}`;
      this.persist();
      await this.refreshCard(proj.id, false);
      await this.tg.sendMessage(
        this.chatId,
        `🚨 BLOQUEADO pela telemetria determinística em ${proj.id}:\n${(tel.testIntegrity.alerts || []).join("\n")}`,
        { threadId: proj.threadId }
      );
      return;
    }

    if (tel.sensitiveTouched.length > 0 && run.risk !== "high") {
      run.risk = "high";
      this.persist();
      await this.tg.sendMessage(
        this.chatId,
        `⚠️ Promoção automática para RISCO ALTO em ${proj.id}: o diff tocou caminhos sensíveis (${tel.sensitiveTouched.join(", ")}). Revise com cuidado no monitor antes de fechar.`,
        { threadId: proj.threadId }
      );
    }

    if (run.pauseRequested) {
      run.status = "PAUSED";
      run.pauseRequested = false;
      run.lastSummary = "Pausado após /aplicar-change conforme solicitado.";
      this.persist();
      await this.refreshCard(proj.id, false);
      await this.tg.sendMessage(this.chatId, `⏸ Pausado após implementação em ${proj.id}. Use /homologar quando quiser seguir.`, { threadId: proj.threadId });
      return;
    }

    await this.startHomologar(proj);
  }

  async startHomologar(proj) {
    const run = this.getRun(proj.id);
    if (!run.changeName || !run.worktreePath) {
      await this.tg.sendMessage(this.chatId, "Nenhuma change ativa para homologar.", { threadId: proj.threadId });
      return;
    }

    const prompt = [
      `Execute a skill .agent/skills/homologar-change/SKILL.md para a change "${run.changeName}".`,
      "Valide entrega.md e ai-kit telemetry, gere roteiro-teste.md se ausente, execute os cenários IA-CLI/IA-UI na sandbox .tmp/homologacao/ e atualize handoff.md.",
      "NUNCA edite código-fonte, NUNCA arquive e NUNCA faça commit/push."
    ].join("\n");

    const args = buildAgyArgs(prompt, "homologar", this.cfg.defaults, { ...proj, agyLogFile: path.join(WORKER_HOME, "logs", `agy-${proj.id}.log`) });
    const res = await this.executeRunner(proj, {
      kind: "agy",
      args,
      stageLabel: "05-Homologar (QA)",
      iaLabel: "Antigravity CLI (T2 · QA)"
    });

    if (await this.handleCommonFailure(proj, res)) return;

    const tel = collectTelemetry(run.worktreePath);
    const handoff = readHandoffSnippet(run.worktreePath, run.changeName) || "";
    const qaFailed = /BLOQUEADA/i.test(handoff);

    if (qaFailed) {
      run.status = "BLOCKED";
      run.lastSummary = "Homologação encontrou falha (ver tasks.md / sandbox preservada).";
      this.persist();
      await this.refreshCard(proj.id, false);
      await this.tg.sendMessage(
        this.chatId,
        `🛑 Homologação BLOQUEADA em ${proj.id} (${run.changeName}).\n\n${handoff}\n\nUse /retomar para devolver ao /aplicar-change ou inspecione no PC.`,
        {
          threadId: proj.threadId,
          buttons: [[{ text: "▶ Devolver ao /aplicar-change", callback_data: `resume:${proj.id}` }]]
        }
      );
      return;
    }

    run.status = "PRONTO_REVISAO";
    run.lastSummary = `Homologado! Diff_Hash ${tel.diffHash || "?"} — aguardando revisão no PC.`;
    this.persist();
    await this.refreshCard(proj.id, false);

    const sens = tel.sensitiveTouched && tel.sensitiveTouched.length
      ? tel.sensitiveTouched.join(", ")
      : "nenhum";

    await this.tg.sendMessage(
      this.chatId,
      [
        `✅ PRONTO PARA REVISÃO NO PC — ${proj.id}`,
        `Change: ${run.changeName}`,
        `Branch / Worktree: ${run.branchName} (${run.worktreePath})`,
        `Diff_Hash: ${tel.diffHash || "—"} | Test_integrity: ${tel.testIntegrity && tel.testIntegrity.ok ? "OK" : "ALERTA"}`,
        `Sensitive_touched: ${sens}`,
        `Diff stat:\n${tel.diffStat || "—"}`,
        "",
        "Teto da autonomia atingido: inspecione o git diff no VS Code e execute concluir-change no PC para arquivar e fazer merge na main."
      ].join("\n"),
      { threadId: proj.threadId }
    );
  }

  async resumeProject(proj) {
    const run = this.getRun(proj.id);
    if (!run.changeName || !run.worktreePath) {
      await this.tg.sendMessage(this.chatId, `Nenhuma change ativa para retomar em ${proj.id}.`, { threadId: proj.threadId });
      return;
    }
    if (run.stage && run.stage.startsWith("05-")) {
      await this.startHomologar(proj);
      return;
    }
    if (run.stage && run.stage.startsWith("02-")) {
      await this.startPropose(proj, run.changeName);
      return;
    }
    if (run.risk === "high" && !run.pcApprovedHighRisk) {
      await this.tg.sendMessage(
        this.chatId,
        `🔴 Change de risco ALTO exige liberação no PC: ai-kit worker approve ${proj.id}`,
        { threadId: proj.threadId }
      );
      return;
    }
    await this.runApplyAndQaPipeline(proj);
  }

  async handleCommonFailure(proj, res) {
    const run = this.getRun(proj.id);
    if (res.abortedByUser) return true;

    if (res.authError) {
      run.status = "BLOCKED";
      run.lastSummary = "Sessão OAuth/login da CLI expirada — reautentique no PC.";
      this.persist();
      await this.refreshCard(proj.id, false);
      await this.tg.sendMessage(
        this.chatId,
        `🔑 Autenticação expirada em ${proj.id} (${run.iaLabel}). Faça login novamente no PowerShell do PC e depois use /retomar.`,
        { threadId: proj.threadId }
      );
      return true;
    }

    if (res.quotaHit) {
      run.status = "PAUSED_QUOTA";
      const reset = res.rateLimit && res.rateLimit.resetsAt ? ` (reset previsto às ${fmtResetTime(res.rateLimit.resetsAt)})` : "";
      run.lastSummary = `Cota esgotada${reset} — aguardando renovação (sem rebaixar modelo).`;
      this.persist();
      await this.refreshCard(proj.id, false);
      await this.tg.sendMessage(
        this.chatId,
        `⏳ Cota esgotada em ${proj.id}${reset}.\nWorktree preservado. Quando a cota renovar, toque abaixo para retomar via handoff.md.`,
        {
          threadId: proj.threadId,
          buttons: [[{ text: "▶ Retomar via handoff", callback_data: `resume:${proj.id}` }]]
        }
      );
      return true;
    }

    if (res.timedOut) {
      run.status = "INTERRUPTED";
      run.lastSummary = "Hard timeout atingido — árvore de processos encerrada.";
      this.persist();
      await this.refreshCard(proj.id, false);
      await this.tg.sendMessage(
        this.chatId,
        `⏱ Timeout rígido atingido em ${proj.id} (${run.stage}). Processo encerrado com worktree preservado.\nÚltimas linhas:\n${res.logTail.slice(-10).join("\n")}`,
        {
          threadId: proj.threadId,
          buttons: [[{ text: "▶ Retomar via handoff", callback_data: `resume:${proj.id}` }]]
        }
      );
      return true;
    }

    if (res.exitCode !== 0) {
      run.status = "BLOCKED";
      run.lastSummary = `CLI encerrou com exit ${res.exitCode}.`;
      this.persist();
      await this.refreshCard(proj.id, false);
      await this.tg.sendMessage(
        this.chatId,
        `❌ Erro em ${proj.id} (${run.stage} · exit ${res.exitCode}):\n\n${res.logTail.slice(-15).join("\n")}`,
        {
          threadId: proj.threadId,
          buttons: [[
            { text: "▶ Retomar", callback_data: `resume:${proj.id}` },
            { text: "📊 Telemetria", callback_data: `tel:${proj.id}` }
          ]]
        }
      );
      return true;
    }

    return false;
  }
}

module.exports = { WorkerOrchestrator };
