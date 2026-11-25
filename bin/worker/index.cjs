#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");
const {
  CONFIG_PATH,
  STATE_PATH,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  maskToken,
  slugifyProject
} = require("./config.cjs");
const { TelegramClient } = require("./telegram.cjs");
const { HookBridgeServer } = require("./hook-server.cjs");
const { WorkerOrchestrator } = require("./orchestrator.cjs");
const { isPidAlive, prepareSpawnInvocation } = require("./runner.cjs");

function printWorkerHelp() {
  console.log(`
ai-kit worker — Orquestrador Multi-IA Headless + Controle via Telegram

Subcomandos:
  ai-kit worker setup-telegram           Wizard interativo (Bot Token, Supergrupo e Tópicos)
  ai-kit worker add-project <slug> <dir> [--thread <id>]  Cadastra/atualiza um projeto
  ai-kit worker start                    Inicia o worker (Telegram Polling + Hook Server + Watchdog)
  ai-kit worker status                   Mostra projetos cadastrados, estado e PIDs
  ai-kit worker approve <slug>           Aprova no PC uma spec marcada como risk: high
  ai-kit worker doctor                   Valida Node, Claude CLI, Antigravity CLI, Git e Telegram

Arquivos locais (dentro do ai-kit, protegidos no .gitignore):
  Config: ${CONFIG_PATH}
  Estado: ${STATE_PATH}
`);
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

async function runSetupTelegram() {
  const cfg = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n=== AI-Kit Worker — Setup do Telegram (Supergrupo com Tópicos) ===\n");
  console.log("Pré-requisitos rápidos no Telegram:");
  console.log("  1. Crie um bot no @BotFather (/newbot) e desative privacy (/setprivacy -> Disable).");
  console.log("  2. Crie um Supergrupo privado (só você + o bot), ative Tópicos e promova o bot a Admin.");
  console.log("  3. Crie um tópico por projeto (ex.: #geral, #qas, #contab-tools).\n");

  const currentHint = cfg.telegram.botToken ? ` [Enter para manter ${maskToken(cfg.telegram.botToken)}]` : "";
  const inputToken = await ask(rl, `Cole o Bot Token do @BotFather${currentHint}: `);
  if (inputToken) cfg.telegram.botToken = inputToken;

  if (!cfg.telegram.botToken) {
    console.error("Erro: Bot Token é obrigatório.");
    rl.close();
    process.exit(1);
  }

  const tg = new TelegramClient(cfg.telegram.botToken);
  let me;
  try {
    me = await tg.getMe();
    console.log(`\n[OK] Bot autenticado: @${me.username} (${me.first_name})`);
  } catch (err) {
    console.error(`[ERRO] Token inválido ou sem internet: ${err.message}`);
    rl.close();
    process.exit(1);
  }

  try {
    await tg.getUpdates(1);
  } catch (_) {}

  console.log("\nAgora abra o seu Supergrupo no Telegram e envie:");
  console.log("  • No tópico #geral: /registrar geral");
  console.log("  • Em cada tópico de projeto: /registrar <slug> <caminho-completo>");
  console.log("    Ex.: /registrar qas D:\\Projetos\\qas");
  console.log("\nAguardando mensagens no Telegram... (pressione Ctrl+C quando terminar de registrar)\n");

  rl.close();

  const onStop = () => {
    tg.stopPolling();
    saveConfig(cfg);
    console.log(`\nConfiguração salva em: ${CONFIG_PATH}`);
    console.log("Próximo passo: rode `ai-kit worker doctor` e depois `ai-kit worker start`.");
    process.exit(0);
  };
  process.on("SIGINT", onStop);

  tg.startPolling(async (upd) => {
    const msg = upd.message;
    if (!msg || !msg.text) return;
    const text = msg.text.trim();
    if (!text.toLowerCase().startsWith("/registrar")) return;

    const fromId = msg.from && msg.from.id;
    const chatId = msg.chat && msg.chat.id;
    const threadId = msg.message_thread_id != null ? Number(msg.message_thread_id) : null;

    if (!cfg.telegram.allowedUserId) cfg.telegram.allowedUserId = fromId;
    if (!cfg.telegram.chatId) cfg.telegram.chatId = chatId;

    const parts = text.split(/\s+/);
    const slug = slugifyProject(parts[1] || "");
    const rawDir = parts.slice(2).join(" ").trim();

    if (!slug || slug === "geral") {
      cfg.telegram.generalThreadId = threadId;
      saveConfig(cfg);
      console.log(`  [REGISTRADO] Tópico #geral (chatId=${chatId}, threadId=${threadId}, userId=${fromId})`);
      await tg.sendMessage(chatId, `✅ Tópico #geral registrado! (userId=${fromId})`, { threadId, silent: true });
      return;
    }

    if (!rawDir) {
      await tg.sendMessage(
        chatId,
        `Informe também o caminho do projeto:\n/registrar ${slug} D:\\Projetos\\${slug}`,
        { threadId, silent: true }
      );
      return;
    }

    const resolvedDir = path.resolve(rawDir);
    const exists = fs.existsSync(resolvedDir);
    cfg.projects[slug] = {
      ...(cfg.projects[slug] || {}),
      path: resolvedDir,
      threadId
    };
    saveConfig(cfg);

    const warn = exists ? "" : " (AVISO: pasta ainda não existe neste PC)";
    console.log(`  [REGISTRADO] Projeto "${slug}" -> ${resolvedDir} (threadId=${threadId})${warn}`);
    await tg.sendMessage(
      chatId,
      `✅ Projeto "${slug}" vinculado a este tópico!\nPasta: ${resolvedDir}${warn}`,
      { threadId, silent: true }
    );
  }, (err) => {
    console.error("[setup polling]", err.message);
  });
}

function runAddProject(args) {
  const slug = slugifyProject(args[0]);
  const dir = args[1];
  const threadIdx = args.indexOf("--thread");
  const threadId = threadIdx > -1 && args[threadIdx + 1] ? Number(args[threadIdx + 1]) : null;

  if (!slug || !dir) {
    console.error("Uso: ai-kit worker add-project <slug> <diretorio> [--thread <id>]");
    process.exit(1);
  }
  const cfg = loadConfig();
  const resolved = path.resolve(dir);
  cfg.projects[slug] = {
    ...(cfg.projects[slug] || {}),
    path: resolved,
    threadId: threadId != null ? threadId : (cfg.projects[slug]?.threadId ?? null)
  };
  saveConfig(cfg);
  console.log(`[OK] Projeto "${slug}" salvo em ${CONFIG_PATH} -> ${resolved} (threadId=${cfg.projects[slug].threadId ?? "não definido"})`);
}

function runStatus() {
  const cfg = loadConfig();
  const state = loadState();
  console.log(`\nAI-Kit Worker — Status (${CONFIG_PATH})`);
  console.log(`  Telegram: token=${maskToken(cfg.telegram.botToken)} | chatId=${cfg.telegram.chatId || "—"} | userId=${cfg.telegram.allowedUserId || "—"}`);
  console.log(`  Projetos (${Object.keys(cfg.projects).length}):`);
  for (const [id, proj] of Object.entries(cfg.projects)) {
    const r = state.runs[id] || { status: "IDLE" };
    const alive = r.pid ? (isPidAlive(r.pid) ? `PID ${r.pid} vivo` : `PID ${r.pid} morto`) : "sem PID";
    console.log(`    - ${id.padEnd(16)} ${String(r.status).padEnd(20)} [${alive}] thread=${proj.threadId ?? "—"} | ${proj.path}`);
    if (r.changeName) {
      console.log(`      change=${r.changeName} | risk=${r.risk || "?"} | worktree=${r.worktreePath || "—"}`);
    }
  }
  console.log("");
}

function runApprovePc(args) {
  const slug = slugifyProject(args[0]);
  if (!slug) {
    console.error("Uso: ai-kit worker approve <slug-do-projeto>");
    process.exit(1);
  }
  const cfg = loadConfig();
  if (!cfg.projects[slug]) {
    console.error(`Projeto "${slug}" não cadastrado em ${CONFIG_PATH}.`);
    process.exit(1);
  }
  const state = loadState();
  const run = state.runs[slug];
  if (!run || !run.changeName) {
    console.error(`Nenhuma change ativa encontrada para "${slug}".`);
    process.exit(1);
  }
  run.pcApprovedHighRisk = true;
  if (run.status === "WAITING_PC_APPROVAL") {
    run.status = "WAITING_APPROVAL";
    run.lastSummary = "Risco HIGH revisado e aprovado no PC — pronto para /retomar no Telegram.";
  }
  saveState(state);
  console.log(`[OK] Change "${run.changeName}" (${slug}) liberada pelo PC.`);
  console.log("Agora você pode enviar /retomar no tópico do Telegram (com o worker rodando) para iniciar a implementação.");
}

function checkBin(bin, args = ["--version"]) {
  const inv = prepareSpawnInvocation(bin, args);
  try {
    const out = execFileSync(inv.command, inv.args, {
      encoding: "utf8",
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 20000,
      ...inv.extraOpts
    }).trim().split(/\r?\n/)[0];
    return { ok: true, version: out, resolvedPath: inv.resolvedPath };
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim().split(/\r?\n/)[0] : "";
    const detail = stderr ? `${err.message} (${stderr})` : err.message;
    return { ok: false, error: `${detail} [bin: ${inv.resolvedPath}]`, resolvedPath: inv.resolvedPath };
  }
}

async function runWorkerDoctor() {
  const cfg = loadConfig();
  let errors = 0;
  const ok = (m) => console.log(`  [OK]    ${m}`);
  const warn = (m) => console.log(`  [WARN]  ${m}`);
  const err = (m) => { errors++; console.log(`  [ERRO]  ${m}`); };

  console.log("\nai-kit worker doctor\n");
  ok(`Node.js ${process.version}`);

  for (const [label, bin] of [
    ["Git", "git"],
    ["Claude CLI", cfg.defaults.claudeBin],
    ["Antigravity CLI", cfg.defaults.agyBin],
    ["OpenSpec CLI", "openspec"]
  ]) {
    const r = checkBin(bin);
    if (r.ok) ok(`${label}: ${r.version}`);
    else if (label === "OpenSpec CLI") warn(`${label} não encontrado no PATH (instale se usar validate/archive).`);
    else err(`${label} (${bin}) não respondeu: ${r.error}`);
  }

  if (!cfg.telegram.botToken) {
    err("Bot Token não configurado. Rode: ai-kit worker setup-telegram");
  } else {
    const tg = new TelegramClient(cfg.telegram.botToken);
    try {
      const me = await tg.getMe();
      ok(`Telegram Bot autenticado: @${me.username}`);
    } catch (e) {
      err(`Falha na API do Telegram: ${e.message}`);
    }
  }

  if (!cfg.telegram.chatId || !cfg.telegram.allowedUserId) {
    warn("chatId ou allowedUserId ausentes. Rode `ai-kit worker setup-telegram` e envie /registrar no grupo.");
  } else {
    ok(`Telegram autorizado: chatId=${cfg.telegram.chatId}, userId=${cfg.telegram.allowedUserId}`);
  }

  const projs = Object.entries(cfg.projects || {});
  if (projs.length === 0) {
    warn("Nenhum projeto cadastrado ainda.");
  } else {
    for (const [id, p] of projs) {
      if (fs.existsSync(p.path)) {
        const hasBridge = fs.existsSync(path.join(p.path, ".claude", "hooks", "worker-bridge.cjs"));
        if (hasBridge) ok(`Projeto "${id}" -> ${p.path} (thread=${p.threadId ?? "—"}, worker-bridge OK)`);
        else warn(`Projeto "${id}" -> ${p.path} sem worker-bridge.cjs (rode: ai-kit sync --target "${p.path}")`);
      } else {
        err(`Projeto "${id}" aponta para pasta inexistente: ${p.path}`);
      }
    }
  }

  console.log(`\nResultado worker doctor: ${errors} erro(s).`);
  if (errors > 0) process.exit(1);
}

async function runStart() {
  const cfg = loadConfig();
  if (!cfg.telegram.botToken || !cfg.telegram.allowedUserId) {
    console.error("Configuração do Telegram incompleta. Rode primeiro:\n  ai-kit worker setup-telegram");
    process.exit(1);
  }

  const tg = new TelegramClient(cfg.telegram.botToken);
  const me = await tg.getMe();

  let orchestrator;
  const hookServer = new HookBridgeServer({
    host: cfg.hookServer.host,
    port: cfg.hookServer.port,
    permissionTimeoutMin: cfg.defaults.permissionTimeoutMin,
    onEvent: (ev) => orchestrator && orchestrator.handleHookTelemetry(ev),
    onPermissionRequest: (reqId, ev) => orchestrator && orchestrator.handlePermissionRequest(reqId, ev)
  });

  const bridgeInfo = await hookServer.start();
  orchestrator = new WorkerOrchestrator(cfg, tg, hookServer);
  await orchestrator.start();

  console.log("\n=== AI-Kit Worker v2.2 Online ===");
  console.log(`  Bot Telegram: @${me.username} (Long Polling ativo)`);
  console.log(`  Hook Bridge:  ${bridgeInfo.url} (protegido por token)`);
  console.log(`  Projetos:     ${Object.keys(cfg.projects).join(", ") || "nenhum"}`);
  console.log(`  Config:       ${CONFIG_PATH}`);
  console.log("Pressione Ctrl+C para encerrar com segurança.\n");

  const shutdown = () => {
    console.log("\nEncerrando AI-Kit Worker...");
    tg.stopPolling();
    orchestrator.stop();
    hookServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  tg.startPolling(
    (upd) => orchestrator.handleTelegramUpdate(upd),
    (err) => console.error(`[${new Date().toTimeString().slice(0, 8)}] Erro polling:`, err.message)
  );
}

async function runWorkerCommand(rawArgs) {
  const sub = rawArgs[0];
  const rest = rawArgs.slice(1);

  if (!sub || sub === "-h" || sub === "--help") {
    printWorkerHelp();
    process.exit(0);
  }
  if (sub === "setup-telegram") return runSetupTelegram();
  if (sub === "add-project") return runAddProject(rest);
  if (sub === "status") return runStatus();
  if (sub === "approve") return runApprovePc(rest);
  if (sub === "doctor") return runWorkerDoctor();
  if (sub === "start") return runStart();

  console.error(`Subcomando desconhecido de worker: "${sub}"`);
  printWorkerHelp();
  process.exit(1);
}

if (require.main === module) {
  runWorkerCommand(process.argv.slice(2)).catch((err) => {
    console.error("Erro fatal no worker:", err.message);
    process.exit(1);
  });
}

module.exports = { runWorkerCommand };
