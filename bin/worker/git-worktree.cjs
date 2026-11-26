#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseProjectYaml, collectTelemetry } = require("../ai-kit.cjs");

function runGit(args, cwd, allowFail = false) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    const msg = (err.stderr || err.stdout || err.message || "").toString().trim();
    throw new Error(`git ${args.join(" ")}: ${msg}`);
  }
}

function detectDefaultBranch(repoRoot) {
  const headRef = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot, true);
  if (headRef && headRef.includes("/")) {
    return headRef.split("/").pop();
  }
  const hasMain = runGit(["rev-parse", "--verify", "main"], repoRoot, true);
  if (hasMain) return "main";
  const hasMaster = runGit(["rev-parse", "--verify", "master"], repoRoot, true);
  if (hasMaster) return "master";
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot, true) || "main";
}

function normalizeSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildChangeName(slugInput) {
  const clean = normalizeSlug(slugInput);
  if (/^\d{4}-\d{2}-\d{2}-/.test(clean)) return clean;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${clean}`;
}

function listDirtyFiles(cwd) {
  const out = runGit(["status", "--porcelain"], cwd, true);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
}

function detectManualSession(repoRoot) {
  const dirty = listDirtyFiles(repoRoot);
  const changesDir = path.join(repoRoot, "openspec", "changes");
  let activeChanges = [];
  if (fs.existsSync(changesDir)) {
    for (const entry of fs.readdirSync(changesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "archive") continue;
      const handoffPath = path.join(changesDir, entry.name, "handoff.md");
      let mtimeMin = null;
      if (fs.existsSync(handoffPath)) {
        const ms = Date.now() - fs.statSync(handoffPath).mtimeMs;
        mtimeMin = Math.round(ms / 60000);
      }
      activeChanges.push({ name: entry.name, handoffUpdatedMinAgo: mtimeMin });
    }
  }
  return {
    dirtyCount: dirty.length,
    dirtySample: dirty.slice(0, 6),
    activeChanges
  };
}

function ensureWorktree(repoRoot, changeName) {
  // Garante .worktrees no .gitignore do projeto principal (sem falhar)
  const worktreesDir = path.join(repoRoot, ".worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true });

  const worktreePath = path.join(worktreesDir, changeName);
  const branchName = `feat/${changeName}`;
  const baseBranch = detectDefaultBranch(repoRoot);

  // Trava anti-colisão: se a mesma change já tem alterações não commitadas no checkout principal, bloqueia
  const mainDirty = listDirtyFiles(repoRoot);
  const colliding = mainDirty.some((f) => f.replace(/\\/g, "/").includes(`openspec/changes/${changeName}/`));
  if (colliding) {
    throw new Error(
      `Colisão detectada: "${changeName}" está sendo editada no checkout principal (provável sessão manual no VS Code).`
    );
  }

  if (fs.existsSync(worktreePath) && fs.existsSync(path.join(worktreePath, ".git"))) {
    return { worktreePath, branchName, baseBranch, reused: true };
  }

  const branchExists = runGit(["rev-parse", "--verify", branchName], repoRoot, true);
  if (branchExists) {
    runGit(["worktree", "add", worktreePath, branchName], repoRoot);
  } else {
    runGit(["worktree", "add", "-b", branchName, worktreePath, baseBranch], repoRoot);
  }

  return { worktreePath, branchName, baseBranch, reused: false };
}

function auditBoundary(worktreePath, stage) {
  const dirty = listDirtyFiles(worktreePath).map((f) => f.replace(/\\/g, "/"));
  if (stage === "explore" || stage === "propose" || stage === "review") {
    const violations = dirty.filter((f) => {
      if (f.startsWith("openspec/")) return false;
      if (f.startsWith("docs/")) return false;
      if (f === "APPLICATION_MAP.md") return false;
      return true;
    });
    return { ok: violations.length === 0, violations, dirty };
  }
  if (stage === "homologar") {
    const violations = dirty.filter((f) => {
      if (f.startsWith(".tmp/")) return false;
      if (/^openspec\/changes\/[^/]+\/(roteiro-teste|handoff|entrega|tasks)\.md$/.test(f)) return false;
      return true;
    });
    return { ok: violations.length === 0, violations, dirty };
  }
  return { ok: true, violations: [], dirty };
}

function parseProposalRisk(worktreePath, changeName) {
  const proposalPath = path.join(worktreePath, "openspec", "changes", changeName, "proposal.md");
  if (!fs.existsSync(proposalPath)) {
    return { exists: false, risk: "medium", needsExplore: false, sensitivePaths: [] };
  }
  const raw = fs.readFileSync(proposalPath, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    return { exists: true, risk: "medium", needsExplore: false, sensitivePaths: [], missingFrontmatter: true };
  }
  const fm = m[1];
  const riskMatch = fm.match(/^risk:\s*([a-zA-Z]+)/m);
  const exploreMatch = fm.match(/^needs_explore:\s*(true|false)/mi);
  const riskRaw = riskMatch ? riskMatch[1].toLowerCase() : "medium";
  const risk = ["low", "medium", "high"].includes(riskRaw) ? riskRaw : "medium";
  const needsExplore = exploreMatch ? exploreMatch[1].toLowerCase() === "true" : false;

  const sensitivePaths = [];
  const listMatch = fm.match(/^sensitive_paths:\s*\[([^\]]*)\]/m);
  if (listMatch && listMatch[1].trim()) {
    for (const part of listMatch[1].split(",")) {
      const clean = part.trim().replace(/^["']|["']$/g, "");
      if (clean) sensitivePaths.push(clean);
    }
  } else {
    const lines = fm.split(/\r?\n/);
    let inSens = false;
    for (const line of lines) {
      if (/^sensitive_paths:\s*$/.test(line.trim())) {
        inSens = true;
        continue;
      }
      if (inSens) {
        const item = line.match(/^\s*-\s*(.+)$/);
        if (item) sensitivePaths.push(item[1].trim().replace(/^["']|["']$/g, ""));
        else if (/^\S/.test(line)) inSens = false;
      }
    }
  }

  return { exists: true, risk, needsExplore, sensitivePaths, missingFrontmatter: false };
}

function parseReviewReport(worktreePath, changeName) {
  const reviewPath = path.join(worktreePath, "openspec", "changes", changeName, "revisao-proposta.md");
  if (!fs.existsSync(reviewPath)) {
    return { exists: false, blockers: null, summary: "revisao-proposta.md não encontrado" };
  }
  const raw = fs.readFileSync(reviewPath, "utf8");
  const m = raw.match(/(\d+)\s+bloqueantes?/i);
  const blockers = m ? Number(m[1]) : 0;
  const validateFail = /openspec validate --strict:\s*Falhou/i.test(raw);
  const summaryLines = raw.split(/\r?\n/).filter((l) => l.trim()).slice(-6).join("\n");
  return {
    exists: true,
    blockers: validateFail ? Math.max(1, blockers) : blockers,
    validateOk: !validateFail,
    summary: summaryLines
  };
}

function readHandoffSnippet(worktreePath, changeName) {
  const handoffPath = path.join(worktreePath, "openspec", "changes", changeName, "handoff.md");
  if (!fs.existsSync(handoffPath)) return null;
  const raw = fs.readFileSync(handoffPath, "utf8").trim();
  return raw.split(/\r?\n/).slice(0, 22).join("\n");
}

function listPendingSlices(repoRoot) {
  const cfg = parseProjectYaml(path.join(repoRoot, ".ai", "project.yaml"));
  const items = [];

  if (cfg.paths && cfg.paths.queue_dir) {
    const qDir = path.join(repoRoot, cfg.paths.queue_dir);
    if (fs.existsSync(qDir)) {
      for (const f of fs.readdirSync(qDir).sort()) {
        if (f.endsWith(".md")) items.push(`fila/${f.replace(/\.md$/, "")}`);
      }
    }
  }

  if (items.length === 0 && cfg.paths && cfg.paths.plan) {
    const planPath = path.join(repoRoot, cfg.paths.plan);
    if (fs.existsSync(planPath)) {
      const lines = fs.readFileSync(planPath, "utf8").split(/\r?\n/);
      for (const line of lines) {
        if (/pendente|em andamento|pr[óo]xima|\[\s\]/i.test(line)) {
          items.push(line.trim().slice(0, 110));
        }
        if (items.length >= 12) break;
      }
    }
  }

  return items;
}


function parseTasksProgress(tasksPath) {
  if (!fs.existsSync(tasksPath)) {
    return { exists: false, done: 0, total: 0, pct: 0, currentBlock: null, mtimeMs: 0 };
  }
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(tasksPath).mtimeMs; } catch (_) {}
  const lines = fs.readFileSync(tasksPath, "utf8").split(/\r?\n/);
  let done = 0;
  let total = 0;
  let activeHeading = null;
  let currentBlock = null;

  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      activeHeading = h[1].trim();
      continue;
    }
    if (/^\s*-\s*\[x\]/i.test(line)) {
      done++;
      total++;
    } else if (/^\s*-\s*\[\s\]/.test(line)) {
      total++;
      if (!currentBlock && activeHeading) {
        currentBlock = activeHeading;
      }
    }
  }
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { exists: true, done, total, pct, currentBlock, mtimeMs };
}

function getLatestFileInDir(dirPath, maxDepth = 2) {
  let best = { mtimeMs: 0, file: null };
  function walk(dir, depth) {
    if (depth > maxDepth || !fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const ms = fs.statSync(full).mtimeMs;
          if (ms > best.mtimeMs) {
            best = { mtimeMs: ms, file: path.relative(dirPath, full).replace(/\\/g, "/") };
          }
        } catch (_) {}
      }
    }
  }
  walk(dirPath, 0);
  return best;
}

function classifyFileKind(relNorm) {
  if (relNorm.startsWith(".tmp/homologacao/") || /roteiro-teste\.md$/i.test(relNorm)) return "qa";
  if (/^openspec\/changes\/[^/]+\/tasks\.md$/i.test(relNorm)) return "tasks";
  if (/^openspec\/changes\/[^/]+\/entrega\.md$/i.test(relNorm)) return "entrega";
  if (/^openspec\/changes\/[^/]+\/handoff\.md$/i.test(relNorm)) return "handoff";
  if (relNorm.startsWith("openspec/") || relNorm.startsWith("docs/")) return "spec";
  return "code";
}

function getLatestRepoActivity(repoRoot, dirtyFiles, changeName) {
  let latest = { mtimeMs: 0, file: null, kind: null };
  let latestCodeMtimeMs = 0;

  const inspectOne = (relPath, fullPath) => {
    try {
      const st = fs.statSync(fullPath);
      if (!st.isFile()) return;
      const norm = relPath.replace(/\\/g, "/");
      const kind = classifyFileKind(norm);
      if (kind === "code" && st.mtimeMs > latestCodeMtimeMs) {
        latestCodeMtimeMs = st.mtimeMs;
      }
      if (st.mtimeMs > latest.mtimeMs) {
        latest = { mtimeMs: st.mtimeMs, file: norm, kind };
      }
    } catch (_) {}
  };

  // Verifica até 250 arquivos sujos do git status
  for (const rel of dirtyFiles.slice(0, 250)) {
    inspectOne(rel, path.join(repoRoot, rel));
  }

  // Verifica também a pasta da change e a sandbox de homologação (.tmp é ignorada pelo git)
  if (changeName) {
    const chDir = path.join(repoRoot, "openspec", "changes", changeName);
    const chBest = getLatestFileInDir(chDir, 3);
    if (chBest.mtimeMs > latest.mtimeMs && chBest.file) {
      const rel = `openspec/changes/${changeName}/${chBest.file}`;
      latest = { mtimeMs: chBest.mtimeMs, file: rel, kind: classifyFileKind(rel) };
    }

    const qaDir = path.join(repoRoot, ".tmp", "homologacao", changeName);
    const qaBest = getLatestFileInDir(qaDir, 2);
    if (qaBest.mtimeMs > latest.mtimeMs && qaBest.file) {
      latest = { mtimeMs: qaBest.mtimeMs, file: `.tmp/homologacao/${changeName}/${qaBest.file}`, kind: "qa" };
    }
  }

  const idleSec = latest.mtimeMs > 0 ? Math.max(0, Math.round((Date.now() - latest.mtimeMs) / 1000)) : null;
  const shortFile = latest.file ? latest.file.split("/").slice(-2).join("/") : null;
  return {
    ...latest,
    shortFile,
    idleSec,
    latestCodeMtimeMs
  };
}

function stageMetadata(phase, tasks, latestActivity) {
  const map = {
    "01-Explorar": { stageLabel: "01-Explorar", ownerIa: "Gemini / Antigravity" },
    "02-Propor": { stageLabel: "02-Propor", ownerIa: "Gemini / Antigravity" },
    "AGUARDANDO_APROVACAO": { stageLabel: "03-Revisar Proposta (aguardando aprovação)", ownerIa: "Gemini / Antigravity → Você" },
    "04-Aplicar": { stageLabel: "04-Aplicar Change", ownerIa: "Claude Code" },
    "PRONTA_PARA_HOMOLOGACAO": { stageLabel: "05-Homologar (pronta para QA)", ownerIa: "Gemini / Antigravity" },
    "05-Homologar": { stageLabel: "05-Homologar (QA)", ownerIa: "Gemini / Antigravity" },
    "AGUARDANDO_HUMANO": { stageLabel: "05-Homologar (checklist humano)", ownerIa: "Você no PC" },
    "HOMOLOGADO": { stageLabel: "06-Concluir (pronta p/ concluir-change)", ownerIa: "Você no PC" },
    "BLOQUEADA": {
      stageLabel: tasks && tasks.exists && tasks.done < tasks.total ? "04-Aplicar Change (bloqueada)" : "Bloqueada (ver handoff.md)",
      ownerIa: tasks && tasks.exists && tasks.done < tasks.total ? "Claude Code" : "Gemini / Antigravity"
    }
  };
  const base = map[phase] || { stageLabel: phase, ownerIa: "Multi-IA" };

  // Quando há atividade ativa em disco, infere qual IA está gravando arquivos agora
  let inferredActiveIa = base.ownerIa;
  if (latestActivity && latestActivity.kind) {
    if (latestActivity.kind === "code" || latestActivity.kind === "tasks" || latestActivity.kind === "entrega") {
      inferredActiveIa = "Claude Code";
    } else if (latestActivity.kind === "qa" || latestActivity.kind === "spec") {
      inferredActiveIa = "Gemini / Antigravity";
    }
  }
  return { ...base, inferredActiveIa };
}

function inspectMainCheckout(repoRoot, diskActiveWindowSec = 120) {
  if (!repoRoot || !fs.existsSync(repoRoot)) {
    return { hasActiveChange: false, dirtyCount: 0, dirtySample: [] };
  }

  const dirty = listDirtyFiles(repoRoot);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot, true) || "main";
  const changesDir = path.join(repoRoot, "openspec", "changes");

  const candidates = [];
  if (fs.existsSync(changesDir)) {
    for (const entry of fs.readdirSync(changesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "archive") continue;
      const full = path.join(changesDir, entry.name);
      const best = getLatestFileInDir(full, 3);
      candidates.push({ name: entry.name, full, mtimeMs: best.mtimeMs });
    }
  }

  if (candidates.length === 0) {
    const latestActivity = getLatestRepoActivity(repoRoot, dirty, null);
    return {
      hasActiveChange: false,
      branch,
      dirtyCount: dirty.length,
      dirtySample: dirty.slice(0, 6),
      latestActivity,
      diskRecentlyActive: latestActivity.idleSec != null && latestActivity.idleSec <= diskActiveWindowSec
    };
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const active = candidates[0];
  const changeName = active.name;
  const changeDir = active.full;

  const tasks = parseTasksProgress(path.join(changeDir, "tasks.md"));
  const riskInfo = parseProposalRisk(repoRoot, changeName);
  const reviewInfo = parseReviewReport(repoRoot, changeName);
  const latestActivity = getLatestRepoActivity(repoRoot, dirty, changeName);

  const handoffPath = path.join(changeDir, "handoff.md");
  let handoffStatus = null;
  let handoffMtimeMs = 0;
  let handoffUpdatedMinAgo = null;
  if (fs.existsSync(handoffPath)) {
    const handoffRaw = fs.readFileSync(handoffPath, "utf8");
    const stMatch = handoffRaw.match(/(?:Status|Estado)\s*:\s*([^\r\n]+)/i);
    if (stMatch) handoffStatus = stMatch[1].trim();
    handoffMtimeMs = fs.statSync(handoffPath).mtimeMs;
    handoffUpdatedMinAgo = Math.round((Date.now() - handoffMtimeMs) / 60000);
  }

  const entregaPath = path.join(changeDir, "entrega.md");
  let entregaStatus = null;
  let entregaMtimeMs = 0;
  if (fs.existsSync(entregaPath)) {
    const raw = fs.readFileSync(entregaPath, "utf8");
    const m = raw.match(/^Status:\s*(.+)$/im);
    if (m) entregaStatus = m[1].trim();
    entregaMtimeMs = fs.statSync(entregaPath).mtimeMs;
  }

  const hasExplore = fs.existsSync(path.join(changeDir, "exploracao.md"));
  const hasProposal = fs.existsSync(path.join(changeDir, "proposal.md"));
  const roteiroPath = path.join(changeDir, "roteiro-teste.md");
  let roteiroValidated = 0;
  let roteiroMtimeMs = 0;
  if (fs.existsSync(roteiroPath)) {
    const matches = fs.readFileSync(roteiroPath, "utf8").match(/\[VALIDADO PELA IA - OK\]/g);
    roteiroValidated = matches ? matches.length : 0;
    roteiroMtimeMs = fs.statSync(roteiroPath).mtimeMs;
  }

  const diskRecentlyActive = latestActivity.idleSec != null && latestActivity.idleSec <= diskActiveWindowSec;
  const blockedRefMtime = Math.max(handoffMtimeMs, entregaMtimeMs);
  const resumedAfterBlocked = blockedRefMtime > 0 && (
    latestActivity.latestCodeMtimeMs > blockedRefMtime + 10000 ||
    tasks.mtimeMs > blockedRefMtime + 10000
  );

  // Deduz fase canônica a partir dos artefatos reais em disco
  let phase = "01-Explorar";
  let staleBlocked = false;
  const hsUpper = String(handoffStatus || "").toUpperCase();
  const entLower = String(entregaStatus || "").toLowerCase();
  const rawBlocked = hsUpper.includes("BLOQUEAD") || entLower.includes("bloqueada");

  if (hsUpper.includes("HOMOLOGADO") && !hsUpper.includes("PRONTA_PARA")) {
    phase = "HOMOLOGADO";
  } else if (hsUpper.includes("AGUARDANDO_HUMANO")) {
    phase = "AGUARDANDO_HUMANO";
  } else if (diskRecentlyActive && latestActivity.kind === "qa") {
    phase = "05-Homologar";
  } else if (entLower.includes("pronta para arquivar") || hsUpper.includes("PRONTA_PARA_HOMOLOGACAO")) {
    phase = (roteiroMtimeMs > entregaMtimeMs + 10000 && diskRecentlyActive) ? "05-Homologar" : "PRONTA_PARA_HOMOLOGACAO";
  } else if (rawBlocked && !resumedAfterBlocked) {
    phase = "BLOQUEADA";
  } else if (tasks.exists && tasks.done > 0 && tasks.done < tasks.total) {
    phase = "04-Aplicar";
    staleBlocked = rawBlocked && resumedAfterBlocked;
  } else if (hsUpper.includes("APROVADO") || (tasks.exists && tasks.done > 0)) {
    phase = "04-Aplicar";
    staleBlocked = rawBlocked && resumedAfterBlocked;
  } else if (hsUpper.includes("AGUARDANDO_APROVACAO") || reviewInfo.exists) {
    phase = "AGUARDANDO_APROVACAO";
  } else if (hasProposal) {
    phase = "02-Propor";
  } else if (hasExplore) {
    phase = "01-Explorar";
  }

  const meta = stageMetadata(phase, tasks, latestActivity);

  return {
    hasActiveChange: true,
    activeChangesCount: candidates.length,
    changeName,
    branch,
    phase,
    stageLabel: meta.stageLabel,
    ownerIa: meta.ownerIa,
    inferredActiveIa: meta.inferredActiveIa,
    staleBlocked,
    risk: riskInfo.exists ? riskInfo.risk : null,
    tasks,
    handoffStatus,
    handoffUpdatedMinAgo,
    entregaStatus,
    reviewExists: reviewInfo.exists,
    reviewBlockers: reviewInfo.blockers,
    roteiroValidated,
    dirtyCount: dirty.length,
    dirtySample: dirty.slice(0, 6),
    latestActivity,
    diskRecentlyActive,
    lastModifiedMinAgo: Math.round((Date.now() - Math.max(active.mtimeMs, latestActivity.mtimeMs || 0)) / 60000)
  };
}

module.exports = {
  runGit,
  detectDefaultBranch,
  normalizeSlug,
  buildChangeName,
  listDirtyFiles,
  detectManualSession,
  inspectMainCheckout,
  parseTasksProgress,
  ensureWorktree,
  auditBoundary,
  parseProposalRisk,
  parseReviewReport,
  readHandoffSnippet,
  listPendingSlices,
  collectTelemetry
};
