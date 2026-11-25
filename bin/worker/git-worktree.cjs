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

module.exports = {
  runGit,
  detectDefaultBranch,
  normalizeSlug,
  buildChangeName,
  listDirtyFiles,
  detectManualSession,
  ensureWorktree,
  auditBoundary,
  parseProposalRisk,
  parseReviewReport,
  readHandoffSnippet,
  listPendingSlices,
  collectTelemetry
};
