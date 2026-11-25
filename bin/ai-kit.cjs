#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const KIT_ROOT = path.resolve(__dirname, "..");
const CORE_DIR = path.join(KIT_ROOT, "core");
const STACKS_DIR = path.join(KIT_ROOT, "stacks");

const VALID_MODES = ["multi-ia", "claude", "gemini"];
const EPHEMERAL_PATH_KEYS = new Set(["qa_sandbox"]);

// Regras de fronteira multi-IA removidas automaticamente de settings.json quando ai.mode == "claude"
const MULTI_IA_ONLY_DENY = new Set([
  "Bash(openspec archive *)",
  "Bash(git commit *)",
  "Bash(git push *)",
  "Edit(**/openspec/specs/**)",
  "Edit(**/openspec/changes/*/proposal.md)",
  "Edit(**/openspec/changes/*/design.md)",
  "Edit(**/openspec/changes/*/specs/**)",
  "Write(**/openspec/specs/**)",
  "Write(**/openspec/changes/*/proposal.md)",
  "Write(**/openspec/changes/*/design.md)",
  "Write(**/openspec/changes/*/specs/**)",
  "MultiEdit(**/openspec/specs/**)",
  "MultiEdit(**/openspec/changes/*/proposal.md)",
  "MultiEdit(**/openspec/changes/*/design.md)",
  "MultiEdit(**/openspec/changes/*/specs/**)"
]);

const REQUIRED_HOOKS = [
  "proteger-arquivos.cjs",
  "verificar-regras.cjs",
  "filtrar-saida-testes.cjs",
  "worker-bridge.cjs"
];

const SENSITIVE_PATH_REGEXES = [
  /(^|\/)migrations?\//i,
  /(^|\/)(auth|security|permissions?|rbac|rls|tenant)\b/i,
  /(^|\/)(dockerfile|docker-compose|compose\.ya?ml)/i,
  /(^|\/)\.claude\/settings\.json$/i,
  /(^|\/)(package\.json|pnpm-workspace\.yaml|[^/]+\.csproj)$/i,
  /(^|\/)\.env(\.|$)/i
];

function printHelp() {
  console.log(`
ai-kit v2.2.1 — Biblioteca Central Multi-IA + Studio + Worker Telegram

Comandos:
  ai-kit studio [opcoes]     Abre o AI-Kit Studio (painel web local de gestao e playbooks)
  ai-kit worker <subcmd>     Orquestrador Multi-IA headless via Telegram (setup-telegram|start|status|approve|doctor)
  ai-kit sync [opcoes]       Sincroniza Core (.agent/.claude/shared) + Stack Packs
  ai-kit doctor [opcoes]     Valida ponteiros, paths:, hooks .cjs, blindagens v2.1 e redundancias
  ai-kit telemetry [opcoes]  Coleta telemetria deterministica do git (diff_hash, risco, testes)
  ai-kit list-stacks         Lista todos os Stack Packs disponiveis com custo estimado em tokens

Opcoes comuns:
  --target <dir>             Diretorio do projeto (padrao: .)
  --mode <modo>              multi-ia | claude | gemini (padrao: le .ai/project.yaml)
  --stacks <a,b,c>           Stacks separadas por virgula (padrao: le .ai/project.yaml)
  --adopt                    Faz backup de arquivos nao-gerenciados antes de substituir
  --prune                    (sync) Remove arquivos orfaos managed-by: ai-kit fora do plano atual
  --dry-run                  Mostra o que seria feito sem gravar arquivos
  --strict                   (doctor) Trata alertas (WARN) como erro (exit 1)
  --json                     (telemetry) Imprime saida estruturada em JSON
  --port <numero>            (studio) Porta local do Studio (padrao: 4789)
  --no-open                  (studio) Nao abre o navegador automaticamente

Exemplos:
  ai-kit studio
  ai-kit worker setup-telegram
  ai-kit worker start
  ai-kit sync --target . --prune
  ai-kit sync --adopt --mode multi-ia --stacks dotnet,react,postgresql --target .
  ai-kit doctor --strict --target .
  ai-kit telemetry --target .
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] && !args[0].startsWith("-") ? args.shift() : null;
  const opts = {
    target: ".",
    mode: null,
    stacks: null,
    adopt: false,
    prune: false,
    dryRun: false,
    strict: false,
    json: false,
    port: 4789,
    noOpen: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--adopt") opts.adopt = true;
    else if (a === "--prune") opts.prune = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--no-open") opts.noOpen = true;
    else if (a === "--target" && args[i + 1]) opts.target = args[++i];
    else if (a === "--mode" && args[i + 1]) opts.mode = args[++i];
    else if (a === "--stacks" && args[i + 1]) opts.stacks = args[++i];
    else if (a === "--port" && args[i + 1]) opts.port = Number(args[++i]) || 4789;
    else if (a === "--project" && args[i + 1]) { i++; }
  }
  return { cmd, opts };
}

function unquote(val) {
  const v = String(val || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseProjectYaml(filePath) {
  const result = {
    exists: false,
    mode: null,
    stacks: [],
    paths: {},
    commands: {},
    limits: {}
  };
  if (!fs.existsSync(filePath)) return result;

  result.exists = true;
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);

  let section = null;
  for (const rawLine of lines) {
    const cleaned = stripInlineComment(rawLine);
    if (!cleaned.trim()) continue;

    const indent = cleaned.match(/^(\s*)/)[1].length;
    const trimmed = cleaned.trim();

    if (indent === 0) {
      const m = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (m) {
        section = m[1];
        if (section === "stacks" && m[2].startsWith("[")) {
          const inner = m[2].replace(/^\[|\]$/g, "").trim();
          if (inner) {
            result.stacks = inner.split(",").map((s) => unquote(s)).filter(Boolean);
          }
        }
      }
      continue;
    }

    if (section === "stacks" && trimmed.startsWith("- ")) {
      const val = unquote(trimmed.slice(2));
      if (val) result.stacks.push(val);
    } else if (section === "ai" && indent === 2) {
      const m = trimmed.match(/^mode:\s*(.+)$/);
      if (m) result.mode = unquote(m[1]);
    } else if ((section === "paths" || section === "commands" || section === "limits") && indent === 2) {
      const m = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
      if (m) {
        const val = unquote(m[2]);
        if (val && val !== "[]" && val !== "{}") {
          result[section][m[1]] = val;
        }
      }
    }
  }

  return result;
}

function walkFiles(dir, baseDir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const base = baseDir || dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, base));
    } else if (entry.isFile()) {
      out.push({ full, rel: path.relative(base, full) });
    }
  }
  return out;
}

function isManagedFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.includes("managed-by: ai-kit") || content.includes('"_managedBy": "ai-kit"');
  } catch (_) {
    return false;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeEmptyDirs(dirPath, stopAt) {
  let cur = dirPath;
  while (cur && cur !== stopAt && fs.existsSync(cur)) {
    const items = fs.readdirSync(cur);
    if (items.length > 0) break;
    fs.rmdirSync(cur);
    cur = path.dirname(cur);
  }
}

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function listAvailableStacks() {
  if (!fs.existsSync(STACKS_DIR)) return [];
  return fs.readdirSync(STACKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function transformSettingsForMode(rawContent, mode) {
  if (mode !== "claude") return rawContent;
  try {
    const parsed = JSON.parse(rawContent);
    if (parsed && parsed.permissions && Array.isArray(parsed.permissions.deny)) {
      parsed.permissions.deny = parsed.permissions.deny.filter((item) => !MULTI_IA_ONLY_DENY.has(item));
    }
    return JSON.stringify(parsed, null, 2) + "\n";
  } catch (_) {
    return rawContent;
  }
}

function copyManagedFile(srcFile, destFile, targetRoot, opts, backupRoot, stats, expectedPaths, overrideContent) {
  const relDest = path.relative(targetRoot, destFile).replace(/\\/g, "/");
  expectedPaths.add(relDest);
  const exists = fs.existsSync(destFile);

  if (exists && !isManagedFile(destFile)) {
    if (!opts.adopt) {
      console.log(`  [PULADO]    ${relDest} (customizado sem managed-by: ai-kit — use --adopt)`);
      stats.skipped++;
      return;
    }
    const backupDest = path.join(backupRoot, relDest);
    if (!opts.dryRun) {
      ensureDir(path.dirname(backupDest));
      fs.copyFileSync(destFile, backupDest);
    }
    console.log(`  [BACKUP]    ${relDest} -> ${path.relative(targetRoot, backupDest).replace(/\\/g, "/")}`);
    stats.backedUp++;
  }

  const content = typeof overrideContent === "string" ? overrideContent : fs.readFileSync(srcFile, "utf8");
  if (exists) {
    const current = fs.readFileSync(destFile, "utf8");
    if (current === content) {
      stats.unchanged++;
      return;
    }
  }

  if (!opts.dryRun) {
    ensureDir(path.dirname(destFile));
    fs.writeFileSync(destFile, content, "utf8");
  }
  console.log(`  [${exists ? "ATUALIZADO" : "CRIADO"} ]  ${relDest}`);
  if (exists) stats.updated++;
  else stats.created++;
}

function pruneOrphans(targetRoot, expectedPaths, opts, stats) {
  const roots = [path.join(targetRoot, ".agent"), path.join(targetRoot, ".claude")];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const f of walkFiles(root)) {
      const rel = path.relative(targetRoot, f.full).replace(/\\/g, "/");
      // Nunca remove regras de dominio do projeto
      if (rel.startsWith(".claude/rules/dominio/")) continue;
      if (expectedPaths.has(rel)) continue;
      if (!isManagedFile(f.full)) continue;

      if (!opts.dryRun) {
        fs.unlinkSync(f.full);
        removeEmptyDirs(path.dirname(f.full), root);
      }
      console.log(`  [REMOVIDO]  ${rel} (orfao managed-by: ai-kit)`);
      stats.pruned++;
    }
  }
}

function runSync(opts) {
  const targetRoot = path.resolve(opts.target);
  const projectYamlPath = path.join(targetRoot, ".ai", "project.yaml");
  const cfg = parseProjectYaml(projectYamlPath);

  let mode = opts.mode || cfg.mode || "multi-ia";
  if (mode === "multi") mode = "multi-ia";
  if (!VALID_MODES.includes(mode)) {
    console.error(`Erro: modo invalido "${mode}". Use: ${VALID_MODES.join(" | ")}`);
    process.exit(1);
  }

  const availableStacks = listAvailableStacks();
  let stacks = [];
  if (opts.stacks) {
    stacks = opts.stacks === "core-only"
      ? []
      : opts.stacks.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  } else if (cfg.stacks.length > 0) {
    stacks = cfg.stacks.map((s) => s.toLowerCase());
  }

  console.log(`\nai-kit sync -> ${targetRoot}`);
  console.log(`  Modo:   ${mode}${cfg.exists ? " (project.yaml detectado)" : " (sem .ai/project.yaml)"}`);
  console.log(`  Stacks: ${stacks.length ? stacks.join(", ") : "core-only"}`);
  if (opts.prune) console.log("  Prune:  ativo (remove orfaos managed-by: ai-kit)");
  if (opts.dryRun) console.log("  [DRY-RUN] Nenhum arquivo sera gravado.");
  console.log("");

  const backupRoot = path.join(targetRoot, ".ai-kit-backup", timestampSlug());
  const stats = { created: 0, updated: 0, unchanged: 0, skipped: 0, backedUp: 0, pruned: 0 };
  const expectedPaths = new Set();
  const sharedSrc = path.join(CORE_DIR, "shared");

  // 1. Core .agent + shared (Gemini / multi-ia)
  if (mode === "multi-ia" || mode === "gemini") {
    const agentSrc = path.join(CORE_DIR, ".agent");
    for (const f of walkFiles(agentSrc)) {
      const dest = path.join(targetRoot, ".agent", f.rel);
      copyManagedFile(f.full, dest, targetRoot, opts, backupRoot, stats, expectedPaths);
    }
    for (const f of walkFiles(sharedSrc)) {
      const dest = path.join(targetRoot, ".agent", f.rel);
      copyManagedFile(f.full, dest, targetRoot, opts, backupRoot, stats, expectedPaths);
    }
  }

  // 2. Core .claude + shared (Claude / multi-ia)
  if (mode === "multi-ia" || mode === "claude") {
    const claudeSrc = path.join(CORE_DIR, ".claude");
    for (const f of walkFiles(claudeSrc)) {
      const dest = path.join(targetRoot, ".claude", f.rel);
      const relNorm = f.rel.replace(/\\/g, "/");
      let overrideContent = null;
      if (relNorm === "settings.json") {
        overrideContent = transformSettingsForMode(fs.readFileSync(f.full, "utf8"), mode);
      }
      copyManagedFile(f.full, dest, targetRoot, opts, backupRoot, stats, expectedPaths, overrideContent);
    }
    for (const f of walkFiles(sharedSrc)) {
      const dest = path.join(targetRoot, ".claude", f.rel);
      copyManagedFile(f.full, dest, targetRoot, opts, backupRoot, stats, expectedPaths);
    }

    // 3. Stack Packs selecionados
    for (const stack of stacks) {
      if (!availableStacks.includes(stack)) {
        console.log(`  [AVISO]     Stack "${stack}" nao encontrada em ${STACKS_DIR}. Disponiveis: ${availableStacks.join(", ")}`);
        continue;
      }
      const stackSrc = path.join(STACKS_DIR, stack);
      for (const f of walkFiles(stackSrc)) {
        const dest = path.join(targetRoot, ".claude", "rules", "stacks", stack, f.rel);
        copyManagedFile(f.full, dest, targetRoot, opts, backupRoot, stats, expectedPaths);
      }
    }
  }

  if (opts.prune) {
    pruneOrphans(targetRoot, expectedPaths, opts, stats);
  }

  console.log(`\nResumo sync: ${stats.created} criado(s), ${stats.updated} atualizado(s), ${stats.unchanged} igual(is), ${stats.skipped} pulado(s), ${stats.backedUp} backup(s), ${stats.pruned} removido(s).`);
  if (!cfg.exists) {
    console.log("Dica: crie .ai/project.yaml, .ai/modelos.md e docs/ antes de rodar ai-kit doctor.");
  }
}

function hasFrontmatterKey(filePath, key) {
  const raw = fs.readFileSync(filePath, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return false;
  const re = new RegExp(`^${key}:`, "m");
  return re.test(m[1]);
}

function stripJsComments(code) {
  return String(code || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => (/^\s*\/\//.test(line) ? "" : line.replace(/\s+\/\/.*$/, "")))
    .join("\n");
}

function runDoctor(opts) {
  const targetRoot = path.resolve(opts.target);
  const projectYamlPath = path.join(targetRoot, ".ai", "project.yaml");
  const cfg = parseProjectYaml(projectYamlPath);

  let errors = 0;
  let warns = 0;

  const ok = (msg) => console.log(`  [OK]    ${msg}`);
  const warn = (msg) => { warns++; console.log(`  [WARN]  ${msg}`); };
  const err = (msg) => { errors++; console.log(`  [ERRO]  ${msg}`); };

  console.log(`\nai-kit doctor v2.2 -> ${targetRoot}\n`);

  // 1. Contrato .ai/project.yaml
  if (!cfg.exists) {
    err(".ai/project.yaml nao encontrado. Execute o scaffold do projeto primeiro.");
  } else {
    ok(`.ai/project.yaml encontrado (mode=${cfg.mode || "nao definido"}, stacks=${cfg.stacks.join(",") || "core-only"})`);
  }

  // 2. Ponteiros de paths:
  for (const [k, relPath] of Object.entries(cfg.paths)) {
    if (EPHEMERAL_PATH_KEYS.has(k)) {
      ok(`paths.${k} -> ${relPath} (efemero)`);
      continue;
    }
    const full = path.join(targetRoot, relPath);
    if (fs.existsSync(full)) ok(`paths.${k} -> ${relPath}`);
    else err(`paths.${k} aponta para "${relPath}", mas o arquivo/pasta nao existe.`);
  }

  // 3. AGENTS.md e CLAUDE.md
  const agentsPath = path.join(targetRoot, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) {
    err("AGENTS.md nao encontrado na raiz.");
  } else {
    const lines = fs.readFileSync(agentsPath, "utf8").split(/\r?\n/).length;
    if (lines > 60) warn(`AGENTS.md tem ${lines} linhas (recomendado <= 60).`);
    else ok(`AGENTS.md (${lines} linhas)`);
  }

  const mode = cfg.mode || "multi-ia";
  const claudePath = path.join(targetRoot, "CLAUDE.md");
  if (mode !== "gemini") {
    if (!fs.existsSync(claudePath)) {
      err("CLAUDE.md nao encontrado na raiz.");
    } else {
      const lines = fs.readFileSync(claudePath, "utf8").split(/\r?\n/).length;
      if (lines > 30) warn(`CLAUDE.md tem ${lines} linhas (recomendado <= 30).`);
      else ok(`CLAUDE.md (${lines} linhas)`);
    }
  }

  // 4. trigger: always_on em .agent/rules/papel-planejador.md
  if (mode !== "claude") {
    const planejadorPath = path.join(targetRoot, ".agent", "rules", "papel-planejador.md");
    if (fs.existsSync(planejadorPath)) {
      if (hasFrontmatterKey(planejadorPath, "trigger")) ok(".agent/rules/papel-planejador.md possui trigger: always_on");
      else warn(".agent/rules/papel-planejador.md sem frontmatter trigger: always_on.");
    }
  }

  // 5. Frontmatter paths: em .claude/rules/dominio e .claude/rules/stacks
  for (const sub of ["dominio", "stacks"]) {
    const dir = path.join(targetRoot, ".claude", "rules", sub);
    if (!fs.existsSync(dir)) continue;
    const mdFiles = walkFiles(dir).filter((f) => f.full.endsWith(".md"));
    for (const f of mdFiles) {
      const rel = path.relative(targetRoot, f.full).replace(/\\/g, "/");
      if (hasFrontmatterKey(f.full, "paths")) ok(`${rel} possui frontmatter paths:`);
      else err(`${rel} NAO possui frontmatter paths: obrigatorio.`);
    }
  }

  // 6. Tamanho de .claude/rules/geral (always-on)
  const geralDir = path.join(targetRoot, ".claude", "rules", "geral");
  if (fs.existsSync(geralDir)) {
    let alwaysOnBytes = 0;
    let onDemandCount = 0;
    for (const f of walkFiles(geralDir)) {
      if (f.full.endsWith(".md") && hasFrontmatterKey(f.full, "paths")) {
        onDemandCount++;
      } else {
        alwaysOnBytes += fs.statSync(f.full).size;
      }
    }
    if (alwaysOnBytes > 8192) {
      warn(`.claude/rules/geral (always-on) soma ${alwaysOnBytes} bytes (limite recomendado: 8192 bytes).`);
    } else {
      ok(`.claude/rules/geral enxuto (always-on: ${alwaysOnBytes} bytes | sob demanda: ${onDemandCount} arquivo(s))`);
    }
  }

  // 7. Hooks .cjs + checagens anti-vibe-coding v2.1
  const hooksDir = path.join(targetRoot, ".claude", "hooks");
  if (mode !== "gemini") {
    if (!fs.existsSync(hooksDir)) {
      warn(".claude/hooks/ nao encontrado (rode ai-kit sync).");
    } else {
      for (const expected of REQUIRED_HOOKS) {
        const p = path.join(hooksDir, expected);
        if (fs.existsSync(p)) ok(`Hook .claude/hooks/${expected} presente`);
        else err(`Hook obrigatorio ausente: .claude/hooks/${expected}`);
      }
      for (const f of walkFiles(hooksDir)) {
        if (f.full.endsWith(".js")) {
          err(`Hook legado .js encontrado (${path.relative(targetRoot, f.full)}). Converta ou remova (use .cjs).`);
        }
      }
      const filterHook = path.join(hooksDir, "filtrar-saida-testes.cjs");
      if (fs.existsSync(filterHook)) {
        const rawHook = fs.readFileSync(filterHook, "utf8");
        const filterCode = stripJsComments(rawHook);
        if (/\bpermissionDecision\s*:\s*["']allow["']/.test(filterCode)) {
          err("filtrar-saida-testes.cjs usa permissionDecision: 'allow' (risco de bypass). Rode ai-kit sync.");
        } else {
          ok("filtrar-saida-testes.cjs endurecido (sem bypass de auto-allow)");
        }
      }
    }

    // 7b. Blindagem do settings.json
    const settingsPath = path.join(targetRoot, ".claude", "settings.json");
    if (fs.existsSync(settingsPath)) {
      try {
        const st = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        const pct = Number(st?.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE || 0);
        if (pct > 0 && pct < 40) {
          warn(`settings.json usa CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${pct} (muito agressivo; recomendado >= 50).`);
        } else {
          ok(`settings.json autocompact equilibrado (${pct || "padrao"}%)`);
        }
        const allow = st?.permissions?.allow || [];
        if (allow.includes("Bash(pnpm -C *)") || allow.includes("Bash(pnpm --filter *)")) {
          warn("settings.json possui wildcard aberto de pnpm (-C * / --filter *). Rode ai-kit sync.");
        } else {
          ok("settings.json sem wildcards abertos de pnpm");
        }
        if (mode === "multi-ia") {
          const deny = st?.permissions?.deny || [];
          if (!deny.includes("Write(**/openspec/changes/*/design.md)")) {
            warn("settings.json em multi-ia nao bloqueia Write() em design.md/specs. Rode ai-kit sync.");
          } else {
            ok("settings.json bloqueia Edit/Write/MultiEdit em artefatos de spec (multi-ia)");
          }
        }
      } catch (e) {
        err(`settings.json invalido: ${e.message}`);
      }
    }
  }

  // 8. .gitignore cobre .env e .tmp
  const gitignorePath = path.join(targetRoot, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    warn(".gitignore nao encontrado na raiz (adicione .env e .tmp/).");
  } else {
    const gi = fs.readFileSync(gitignorePath, "utf8");
    const hasEnv = /(^|\r?\n)\s*\.env(\b|\.|\/|\*|$)/m.test(gi);
    const hasTmp = /(^|\r?\n)\s*\.tmp(\/|\r?\n|$)/m.test(gi);
    if (hasEnv) ok(".gitignore protege .env");
    else warn(".gitignore nao lista .env.");
    if (hasTmp) ok(".gitignore ignora .tmp/ (sandbox de homologacao)");
    else warn(".gitignore nao lista .tmp/ (adicione .tmp/ para a sandbox de homologacao).");
  }

  // 9. Frontmatter de Tier/Esforco/Fallback em todas as skills
  for (const skillsRoot of [path.join(targetRoot, ".agent", "skills"), path.join(targetRoot, ".claude", "skills")]) {
    if (!fs.existsSync(skillsRoot)) continue;
    const skillFiles = walkFiles(skillsRoot).filter((f) => path.basename(f.full) === "SKILL.md");
    for (const f of skillFiles) {
      const rel = path.relative(targetRoot, f.full).replace(/\\/g, "/");
      const missing = ["tier_ideal", "esforco_ideal", "fallback_cota"].filter((k) => !hasFrontmatterKey(f.full, k));
      if (missing.length === 0) ok(`Skill ${rel} (tier/esforco/fallback OK)`);
      else warn(`Skill ${rel} sem metadados: ${missing.join(", ")}`);
    }
  }

  // 10. Redundancias proibidas
  const retiredPaths = [
    ".claude/commands/opsx/apply.md",
    ".claude/skills/openspec-apply-change"
  ];
  for (const r of retiredPaths) {
    if (fs.existsSync(path.join(targetRoot, r))) {
      err(`Arquivo/pasta redundante do padrao legado ainda existe: ${r}`);
    }
  }

  const workflowsDir = path.join(targetRoot, ".agent", "workflows");
  if (fs.existsSync(workflowsDir)) {
    const legacyWf = walkFiles(workflowsDir).filter((f) => path.basename(f.full).startsWith("opsx-"));
    for (const wf of legacyWf) {
      err(`Workflow espelhado redundante encontrado: ${path.relative(targetRoot, wf.full).replace(/\\/g, "/")}`);
    }
  }

  for (const skillsRoot of [path.join(targetRoot, ".agent", "skills"), path.join(targetRoot, ".claude", "skills")]) {
    if (!fs.existsSync(skillsRoot)) continue;
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("mapa-")) {
        err(`Skill mapa-* duplicada encontrada em ${path.relative(targetRoot, path.join(skillsRoot, entry.name)).replace(/\\/g, "/")} (consolide em APPLICATION_MAP.md).`);
      }
    }
  }

  console.log(`\nResultado doctor: ${errors} erro(s), ${warns} aviso(s).`);
  if (errors > 0 || (opts.strict && warns > 0)) {
    process.exit(1);
  }
}

function safeGit(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (_) {
    return null;
  }
}

function collectTelemetry(targetRoot) {
  const isGit = safeGit("git rev-parse --is-inside-work-tree", targetRoot);
  if (isGit !== "true") {
    return {
      isGit: false,
      error: "Diretorio alvo nao e um repositorio Git."
    };
  }

  const branch = safeGit("git rev-parse --abbrev-ref HEAD", targetRoot) || "unknown";
  const head = safeGit("git rev-parse --short HEAD", targetRoot) || "sem-commit";
  const porcelain = safeGit("git status --porcelain", targetRoot) || "";
  const diffStat = safeGit("git diff --stat", targetRoot) || "";
  const diffStagedStat = safeGit("git diff --cached --stat", targetRoot) || "";
  const fullDiff = (safeGit("git diff", targetRoot) || "") + "\n" + (safeGit("git diff --cached", targetRoot) || "");

  const dirtyFiles = porcelain
    ? porcelain.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
    : [];

  const hashInput = `${head}\n${porcelain}\n${fullDiff}`;
  const diffHash = crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 12);

  const sensitiveTouched = dirtyFiles.filter((f) => SENSITIVE_PATH_REGEXES.some((re) => re.test(f.replace(/\\/g, "/"))));

  // Inspecao deterministica de integridade de testes e supressoes no diff
  const testIntegrityAlerts = [];
  let currentFile = "";
  let removedAssertions = 0;
  let addedAssertions = 0;
  const assertionRe = /\b(Assert\.|expect\s*\(|Should[A-Z]\w*|\.Should\(\))/g;
  const skipRe = /\b(it|test|describe)\.(skip|only)\s*\(|\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(|\[(Fact|Theory|Test)\s*\([^)]*Skip\s*=|\[Ignore\b/;
  const suppressRe = /@ts-(ignore|nocheck|expect-error)|eslint-disable|biome-ignore|#pragma\s+warning\s+disable/;

  const isTestPath = (p) => /(^|\/)(tests?|__tests__|e2e|[^/]*\.Tests)\//i.test(p)
    || /\.(test|spec|e2e)\.[jt]sx?$/i.test(p)
    || /(Test|Tests|Spec)\.cs$/i.test(p);

  for (const line of fullDiff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const body = line.slice(1);
      if (isTestPath(currentFile)) {
        const m = body.match(assertionRe);
        if (m) addedAssertions += m.length;
        if (skipRe.test(body)) {
          testIntegrityAlerts.push(`skip/only adicionado em ${currentFile}`);
        }
      }
      if (suppressRe.test(body)) {
        testIntegrityAlerts.push(`supressao de lint/tipo/compilador adicionada em ${currentFile}`);
      }
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (isTestPath(currentFile)) {
        const m = line.slice(1).match(assertionRe);
        if (m) removedAssertions += m.length;
      }
    }
  }

  if (removedAssertions > addedAssertions) {
    testIntegrityAlerts.push(`saldo negativo de assertions em testes (-${removedAssertions} / +${addedAssertions})`);
  }

  // Sugestao deterministica de suites tocadas a partir das extensoes/pastas
  const hints = new Set();
  for (const f of dirtyFiles) {
    const norm = f.replace(/\\/g, "/").toLowerCase();
    if (norm.endsWith(".cs") || norm.endsWith(".csproj")) hints.add("dotnet");
    if (norm.endsWith(".tsx") || norm.endsWith(".jsx") || norm.includes("/web/") || norm.includes("/frontend/")) hints.add("frontend");
    if (norm.includes("e2e/") || norm.endsWith(".e2e.ts") || norm.includes("playwright")) hints.add("e2e");
    if (norm.endsWith(".ts") || norm.endsWith(".js") || norm.endsWith(".cjs")) hints.add("node");
    if (norm.endsWith(".sql") || norm.includes("migrations/")) hints.add("database");
  }

  return {
    isGit: true,
    target: targetRoot,
    branch,
    head,
    diffHash,
    dirtyCount: dirtyFiles.length,
    dirtyFiles,
    diffStat: [diffStagedStat, diffStat].filter(Boolean).join("\n") || "sem alteracoes tracked",
    sensitiveTouched,
    riskEscalation: sensitiveTouched.length > 0 ? "HIGH (sensitive_paths tocados)" : "normal",
    testIntegrity: {
      ok: testIntegrityAlerts.length === 0,
      addedAssertions,
      removedAssertions,
      alerts: Array.from(new Set(testIntegrityAlerts))
    },
    suitesHint: Array.from(hints)
  };
}

function runTelemetry(opts) {
  const targetRoot = path.resolve(opts.target);
  const data = collectTelemetry(targetRoot);

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    if (!data.isGit || !data.testIntegrity.ok) process.exit(1);
    return;
  }

  if (!data.isGit) {
    console.error(`[ERRO] ${data.error}`);
    process.exit(1);
  }

  console.log(`\nai-kit telemetry -> ${targetRoot}`);
  console.log(`  Branch / HEAD:     ${data.branch} @ ${data.head}`);
  console.log(`  Diff_Hash:         ${data.diffHash}`);
  console.log(`  Arquivos tocados:  ${data.dirtyCount}`);
  console.log(`  Suites_hint:       ${data.suitesHint.length ? data.suitesHint.join(", ") : "nenhuma"}`);
  console.log(`  Sensitive_touched: ${data.sensitiveTouched.length ? data.sensitiveTouched.join(", ") : "nenhum"}`);
  console.log(`  Risco sugerido:    ${data.riskEscalation}`);
  console.log(`  Test_integrity:    ${data.testIntegrity.ok ? "OK" : "ALERTA"} (assertions +${data.testIntegrity.addedAssertions}/-${data.testIntegrity.removedAssertions})`);
  if (data.testIntegrity.alerts.length) {
    for (const a of data.testIntegrity.alerts) {
      console.log(`    [ALERTA] ${a}`);
    }
  }
  console.log("\nDiff Stat:");
  console.log(data.diffStat.split("\n").map((l) => `  ${l}`).join("\n"));
  console.log("");

  if (!data.testIntegrity.ok) process.exit(1);
}

function runListStacks() {
  console.log("Stack Packs disponiveis:");
  for (const s of listAvailableStacks()) {
    const files = walkFiles(path.join(STACKS_DIR, s));
    const bytes = files.reduce((acc, f) => acc + fs.statSync(f.full).size, 0);
    const estTokens = Math.ceil(bytes / 4);
    console.log(`  - ${s.padEnd(14)} (${files.length} arquivo(s), ~${estTokens} tokens)`);
  }
}

function main() {
  if (process.argv[2] === "worker") {
    const worker = require("./worker/index.cjs");
    worker.runWorkerCommand(process.argv.slice(3)).catch((err) => {
      console.error("Erro no worker:", err.message);
      process.exit(1);
    });
    return;
  }
  const { cmd, opts } = parseArgs(process.argv);
  if (opts.help || !cmd) {
    printHelp();
    process.exit(0);
  }
  if (cmd === "sync") {
    runSync(opts);
  } else if (cmd === "doctor") {
    runDoctor(opts);
  } else if (cmd === "telemetry") {
    runTelemetry(opts);
  } else if (cmd === "list-stacks") {
    runListStacks();
  } else if (cmd === "studio") {
    const studio = require("./ai-kit-studio.cjs");
    studio.startStudio({ port: opts.port, noOpen: opts.noOpen });
  } else {
    console.error(`Comando desconhecido: "${cmd}"`);
    printHelp();
    process.exit(1);
  }
}

module.exports = { collectTelemetry, listAvailableStacks, parseProjectYaml };

if (require.main === module) {
  main();
}
