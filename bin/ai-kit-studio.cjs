#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFile, spawn } = require("child_process");

const KIT_ROOT = path.resolve(__dirname, "..");
const STUDIO_HTML = path.join(KIT_ROOT, "studio", "index.html");
const CLI_BIN = path.join(KIT_ROOT, "bin", "ai-kit.cjs");

const PROTECTED_FILES = new Set([
  "package.json",
  "README.md",
  "bin/ai-kit.cjs",
  "bin/ai-kit-studio.cjs",
  "studio/index.html",
  "core/.claude/settings.json",
  "core/.claude/hooks/proteger-arquivos.cjs",
  "core/.claude/hooks/verificar-regras.cjs",
  "core/.claude/hooks/filtrar-saida-testes.cjs",
  "core/.claude/hooks/worker-bridge.cjs"
]);

function safeResolve(relPath) {
  const clean = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("..") || clean.startsWith(".worker-data")) return null;
  const full = path.resolve(KIT_ROOT, clean);
  if (!full.startsWith(KIT_ROOT + path.sep) && full !== KIT_ROOT) return null;
  return { full, rel: path.relative(KIT_ROOT, full).replace(/\\/g, "/") };
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const block = m[1];
  const meta = {};
  const lines = block.split(/\r?\n/);
  let currentListKey = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (currentListKey && trimmed.startsWith("- ")) {
      meta[currentListKey].push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const kv = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) {
      const k = kv[1];
      const v = kv[2].trim();
      if (!v) {
        meta[k] = [];
        currentListKey = k;
      } else {
        meta[k] = v.replace(/^["']|["']$/g, "");
        currentListKey = null;
      }
    }
  }
  return meta;
}

function classifyItem(rel, content, meta) {
  let category = "outros";
  let groupLabel = "Outros";
  if (rel.startsWith("core/shared/skills/")) {
    category = "skill-shared";
    groupLabel = "Shared (Gemini & Claude)";
  } else if (rel.startsWith("core/.agent/skills/")) {
    category = "skill-agent";
    groupLabel = "Planejador (.agent) — Skills";
  } else if (rel.startsWith("core/.agent/rules/")) {
    category = "rule-agent";
    groupLabel = "Planejador (.agent) — Rules";
  } else if (rel.startsWith("core/.claude/skills/")) {
    category = "skill-claude";
    groupLabel = "Executor (.claude) — Skills";
  } else if (rel.startsWith("core/.claude/rules/geral/")) {
    category = "rule-geral";
    groupLabel = "Executor (.claude) — Rules Geral";
  } else if (rel.startsWith("core/.claude/agents/")) {
    category = "agent";
    groupLabel = "Subagentes (.claude)";
  } else if (rel.startsWith("core/.claude/hooks/")) {
    category = "hook";
    groupLabel = "Hooks (.cjs)";
  } else if (rel === "core/.claude/settings.json") {
    category = "config";
    groupLabel = "Configuração Core";
  } else if (rel.startsWith("stacks/")) {
    category = "stack";
    groupLabel = "Stack Packs";
  } else if (rel === "README.md" || rel === "package.json") {
    category = "meta";
    groupLabel = "Metadados do Kit";
  }

  const hasPaths = Boolean(meta && meta.paths && (!Array.isArray(meta.paths) || meta.paths.length > 0));
  const isAlwaysOn =
    (category === "rule-geral" && !hasPaths) ||
    (category === "rule-agent" && meta && meta.trigger === "always_on");

  const warnings = validateFileContent(rel, content, category, meta);

  const bytes = Buffer.byteLength(content, "utf8");
  const lines = content.split(/\r?\n/).length;
  const estTokens = Math.ceil(bytes / 4);

  return {
    path: rel,
    name: path.basename(rel),
    title: (meta && meta.name) || (rel.startsWith("stacks/") ? rel.split("/")[1] : path.basename(rel, path.extname(rel))),
    description: (meta && meta.description) || "",
    category,
    groupLabel,
    bytes,
    lines,
    estTokens,
    alwaysOn: isAlwaysOn,
    hasPaths,
    managedBy: Boolean(content.includes("managed-by: ai-kit") || content.includes('"_managedBy": "ai-kit"')),
    tier: (meta && meta.tier_ideal) || null,
    esforco: (meta && meta.esforco_ideal) || null,
    fallback: (meta && meta.fallback_cota) || null,
    protected: PROTECTED_FILES.has(rel),
    warnings
  };
}

function validateFileContent(rel, content, category, meta) {
  const warnings = [];
  if (rel.startsWith("core/") || rel.startsWith("stacks/")) {
    if (!content.includes("managed-by: ai-kit") && !content.includes('"_managedBy": "ai-kit"')) {
      warnings.push("Falta marcador 'managed-by: ai-kit' (necessário para sync protegido).");
    }
  }
  if (rel.endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch (e) {
      warnings.push(`JSON inválido: ${e.message}`);
    }
  }
  if (rel.endsWith(".cjs") || rel.endsWith(".js")) {
    try {
      const cleaned = content.replace(/^#!.*\r?\n/, "");
      new vm.Script(cleaned, { filename: rel });
    } catch (e) {
      warnings.push(`Erro de sintaxe JS: ${e.message}`);
    }
  }
  if (category === "stack") {
    if (!meta || !meta.paths) warnings.push("Stack Pack exige frontmatter 'paths:' para carregar sob demanda.");
  }
  if (category.startsWith("skill-")) {
    for (const k of ["name", "description", "tier_ideal", "esforco_ideal", "fallback_cota"]) {
      if (!meta || !meta[k]) warnings.push(`Skill sem frontmatter '${k}:'.`);
    }
    if (/^##\s+Preflight de Modelo/m.test(content)) {
      warnings.push("Bloco '## Preflight de Modelo' redundante (regra já é global — remover economiza tokens).");
    }
  }
  if (category === "rule-agent" && (!meta || meta.trigger !== "always_on")) {
    warnings.push("Rule do planejador sem 'trigger: always_on'.");
  }
  return warnings;
}

function stripJsComments(code) {
  return String(code || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => (/^\s*\/\//.test(line) ? "" : line.replace(/\s+\/\/.*$/, "")))
    .join("\n");
}

function computeGuardrails() {
  const readRel = (r) => {
    const p = path.join(KIT_ROOT, r);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  };
  const filterHook = readRel("core/.claude/hooks/filtrar-saida-testes.cjs");
  const filterCode = stripJsComments(filterHook);
  const hasAutoAllow = /\bpermissionDecision\s*:\s*["']allow["']/.test(filterCode);
  const bridgeHook = readRel("core/.claude/hooks/worker-bridge.cjs");
  const protectHook = readRel("core/.claude/hooks/proteger-arquivos.cjs");
  const verifyHook = readRel("core/.claude/hooks/verificar-regras.cjs");
  const settingsRaw = readRel("core/.claude/settings.json");
  const testesRule = readRel("core/.claude/rules/geral/testes.md");
  const cliRaw = readRel("bin/ai-kit.cjs");
  const sharedRetomar = fs.existsSync(path.join(KIT_ROOT, "core/shared/skills/retomar-change/SKILL.md"));

  let settings = {};
  try { settings = JSON.parse(settingsRaw); } catch (_) {}
  const deny = settings?.permissions?.deny || [];
  const allow = settings?.permissions?.allow || [];
  const compactPct = Number(settings?.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE || 0);

  return [
    {
      id: "no-bypass-filter",
      title: "Filtro de testes sem auto-allow e sem bypass composto",
      ok: Boolean(filterCode) && !hasAutoAllow && filterCode.includes("encontrarFiltroSeguro"),
      detail: "filtrar-saida-testes.cjs bloqueia comandos compostos (;, |, ||, subshell) e respeita permissions.deny."
    },
    {
      id: "anti-sabotage-tests",
      title: "Trava anti-sabotagem de testes e supressões",
      ok: verifyHook.includes("countAssertions") && verifyHook.includes("eslint-disable"),
      detail: "verificar-regras.cjs detecta .skip/only, @ts-ignore, eslint-disable, #pragma disable e queda de assertions."
    },
    {
      id: "protect-edit-multiedit",
      title: "Proteção paths: em Write, Edit e MultiEdit",
      ok: protectHook.includes("extractTargets") && protectHook.includes("isCentralAiKitRepo"),
      detail: "proteger-arquivos.cjs valida Write/Edit/MultiEdit em .claude/rules/dominio/ e .env."
    },
    {
      id: "closed-permissions",
      title: "Permissões fechadas (Write/MultiEdit + pnpm restrito)",
      ok: deny.includes("Write(**/openspec/changes/*/design.md)") && !allow.includes("Bash(pnpm -C *)"),
      detail: "Bloqueia sobrescrita de specs em multi-ia e fecha wildcards abertos de pnpm."
    },
    {
      id: "autocompact-balanced",
      title: `Autocompact equilibrado (${compactPct || "padrão"}%)`,
      ok: compactPct >= 45 || compactPct === 0,
      detail: "Evita compactações prematuras em cascata (v2.0 usava 20%, v2.1 usa 55%)."
    },
    {
      id: "testes-scoped",
      title: "Regra testes.md escopada só para arquivos de teste",
      ok: testesRule.includes("*.Tests/**/*.cs") || testesRule.includes("**/__tests__/**"),
      detail: "Economiza ~300 tokens por leitura de código de produção."
    },
    {
      id: "single-source-retomar",
      title: "Fonte única para retomar-change + sync --prune",
      ok: sharedRetomar && cliRaw.includes("pruneOrphans"),
      detail: "core/shared/ sincroniza automaticamente para .agent e .claude sem duplicação."
    },
    {
      id: "deterministic-telemetry",
      title: "Telemetria determinística (Diff_Hash + Test_integrity)",
      ok: cliRaw.includes("collectTelemetry") && cliRaw.includes("diffHash"),
      detail: "ai-kit telemetry gera evidência objetiva fora do LLM para validar entrega e arquivamento."
    },
    {
      id: "worker-remote-bridge",
      title: "Ponte remota fail-closed + visibilidade de subagentes (v2.2.5)",
      ok: bridgeHook.includes("PermissionRequest") && bridgeHook.includes("AI_KIT_WORKER_URL") && Boolean(settings?.hooks?.SubagentStart) && Boolean(settings?.hooks?.UserPromptSubmit) && !/"matcher"\s*:\s*"\*"/.test(settingsRaw),
      detail: "worker-bridge.cjs monitora SubagentStart/Stop e encaminha PermissionRequest ao Telegram (inativo no uso manual)."
    }
  ];
}

function buildInventory() {
  const roots = [
    path.join(KIT_ROOT, "core"),
    path.join(KIT_ROOT, "stacks")
  ];
  const filePaths = [];
  for (const r of roots) filePaths.push(...walkFiles(r));
  for (const top of ["README.md", "package.json"]) {
    const p = path.join(KIT_ROOT, top);
    if (fs.existsSync(p)) filePaths.push(p);
  }

  const items = [];
  for (const full of filePaths) {
    const rel = path.relative(KIT_ROOT, full).replace(/\\/g, "/");
    const content = fs.readFileSync(full, "utf8");
    const meta = rel.endsWith(".md") ? parseFrontmatter(content) : null;
    items.push(classifyItem(rel, content, meta));
  }

  items.sort((a, b) => a.path.localeCompare(b.path));

  const stacksDir = path.join(KIT_ROOT, "stacks");
  const stacks = fs.existsSync(stacksDir)
    ? fs.readdirSync(stacksDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];

  let totalBytes = 0;
  let totalTokens = 0;
  let alwaysOnBytes = 0;
  let alwaysOnTokens = 0;
  let onDemandTokens = 0;
  let warningCount = 0;
  const byCategory = {};

  for (const it of items) {
    totalBytes += it.bytes;
    totalTokens += it.estTokens;
    warningCount += it.warnings.length;
    if (it.alwaysOn) {
      alwaysOnBytes += it.bytes;
      alwaysOnTokens += it.estTokens;
    } else if (it.category !== "meta" && it.category !== "config") {
      onDemandTokens += it.estTokens;
    }
    byCategory[it.category] = (byCategory[it.category] || 0) + it.estTokens;
  }

  let version = "2.1.0";
  try {
    version = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "package.json"), "utf8")).version || version;
  } catch (_) {}

  return {
    kitRoot: KIT_ROOT,
    version,
    stacks,
    summary: {
      fileCount: items.length,
      totalBytes,
      totalTokens,
      alwaysOnBytes,
      alwaysOnTokens,
      onDemandTokens,
      warningCount,
      skillsCount: items.filter((i) => i.category.startsWith("skill-")).length,
      rulesCount: items.filter((i) => i.category.startsWith("rule-")).length,
      hooksCount: items.filter((i) => i.category === "hook").length,
      agentsCount: items.filter((i) => i.category === "agent").length,
      stacksCount: stacks.length,
      byCategory
    },
    guardrails: computeGuardrails(),
    items
  };
}

function buildTemplate(kind, slug, title, extra) {
  const safeSlug = String(slug || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  const cleanTitle = title || safeSlug;
  if (!safeSlug) throw new Error("Slug inválido. Use letras minúsculas, números e hífen.");

  if (kind === "skill-agent" || kind === "skill-claude" || kind === "skill-shared") {
    const base = kind === "skill-agent"
      ? `core/.agent/skills/${safeSlug}/SKILL.md`
      : kind === "skill-claude"
        ? `core/.claude/skills/${safeSlug}/SKILL.md`
        : `core/shared/skills/${safeSlug}/SKILL.md`;
    const tier = extra?.tier || "T2_CONSTRUTOR";
    const esforco = extra?.esforco || "medium";
    const fallback = extra?.fallback || "T3_OPERADOR";
    const desc = extra?.description || `Executa a skill ${cleanTitle} seguindo o fluxo OpenSpec SDD.`;
    const content = `---
name: ${safeSlug}
description: ${desc}
managed-by: ai-kit
tier_ideal: ${tier}
esforco_ideal: ${esforco}
fallback_cota: ${fallback}
---

# Skill: ${safeSlug}

## Leitura Mínima Obrigatória
1. \`.ai/project.yaml\`
2. Apenas os artefatos estritamente necessários à tarefa (use \`grep\` e leitura com \`offset\`/\`limit\`).

## Passos
1. Valide pré-condições antes de editar qualquer arquivo.
2. Execute as ações de forma determinística e objetiva.
3. Registre evidências reais e atualize \`handoff.md\` (< 40 linhas) quando aplicável.
`;
    return { rel: base, content };
  }

  if (kind === "rule-geral") {
    const pathsGlob = extra?.paths || "**/*.{cs,ts,tsx,js,jsx,mjs}";
    const content = `---
managed-by: ai-kit
paths:
  - "${pathsGlob}"
---

# ${cleanTitle}

- Regra objetiva e verificável 1.
- Regra objetiva e verificável 2.
`;
    return { rel: `core/.claude/rules/geral/${safeSlug}.md`, content };
  }

  if (kind === "stack") {
    const pathsGlob = extra?.paths || `**/*.${safeSlug}`;
    const content = `---
managed-by: ai-kit
paths:
  - "${pathsGlob}"
---

# Stack Pack: ${cleanTitle}

- Convenção principal de arquitetura e camadas desta stack.
- Padrão de validação, tipagem e tratamento de erros.
- Comando e convenção de testes automatizados.
`;
    return { rel: `stacks/${safeSlug}/${safeSlug}.md`, content };
  }

  if (kind === "agent") {
    const model = extra?.model || "sonnet";
    const tier = extra?.tier || "T2_CONSTRUTOR";
    const content = `---
name: ${safeSlug}
description: Subagente especializado em ${cleanTitle}.
managed-by: ai-kit
model: ${model}
tier_ideal: ${tier}
esforco_ideal: medium
fallback_cota: ${tier}
---

# Subagent: ${safeSlug}

## Limites Estritos
- Nunca lance outros subagentes.
- Altere apenas o escopo atribuído.

## Protocolo
1. Leia \`.ai/project.yaml\` e somente os arquivos do escopo.
2. Execute a tarefa com evidência literal e retorno compacto (máx. 12 linhas).
`;
    return { rel: `core/.claude/agents/${safeSlug}.md`, content };
  }

  if (kind === "hook") {
    const content = `#!/usr/bin/env node
// managed-by: ai-kit
// Hook customizado: ${cleanTitle}
"use strict";

const fs = require("fs");

function main() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) process.exit(0);
    const payload = JSON.parse(raw);
    // Implemente a validação determinística aqui
    void payload;
    process.exit(0);
  } catch (_) {
    process.exit(0);
  }
}

main();
`;
    return { rel: `core/.claude/hooks/${safeSlug}.cjs`, content };
  }

  throw new Error(`Tipo desconhecido: ${kind}`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error("Payload excede 2 MB."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error("JSON inválido no corpo da requisição."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function runCliAction(body) {
  return new Promise((resolve) => {
    const allowedCmds = new Set(["doctor", "sync", "telemetry", "list-stacks"]);
    const cmd = String(body.command || "");
    if (!allowedCmds.has(cmd)) {
      return resolve({ ok: false, exitCode: 1, stdout: "", stderr: `Comando não permitido: ${cmd}`, durationMs: 0 });
    }

    const args = [CLI_BIN, cmd];
    const target = String(body.target || "").trim();
    if (cmd !== "list-stacks") {
      if (!target) {
        return resolve({ ok: false, exitCode: 1, stdout: "", stderr: "Informe o diretório --target do projeto.", durationMs: 0 });
      }
      if (!fs.existsSync(target)) {
        return resolve({ ok: false, exitCode: 1, stdout: "", stderr: `Diretório não encontrado: ${target}`, durationMs: 0 });
      }
      args.push("--target", target);
    }

    if (cmd === "doctor" && body.strict) args.push("--strict");
    if (cmd === "telemetry" && body.json) args.push("--json");
    if (cmd === "sync") {
      if (body.dryRun) args.push("--dry-run");
      if (body.adopt) args.push("--adopt");
      if (body.prune) args.push("--prune");
      if (body.mode && ["multi-ia", "claude", "gemini"].includes(body.mode)) {
        args.push("--mode", body.mode);
      }
      if (body.stacks && String(body.stacks).trim()) {
        args.push("--stacks", String(body.stacks).trim());
      }
    }

    const started = Date.now();
    execFile(process.execPath, args, { cwd: KIT_ROOT, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const durationMs = Date.now() - started;
      const exitCode = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      let telemetryJson = null;
      if (cmd === "telemetry" && body.json) {
        try { telemetryJson = JSON.parse(stdout); } catch (_) {}
      }
      resolve({
        ok: exitCode === 0,
        exitCode,
        commandLine: `ai-kit ${args.slice(1).join(" ")}`,
        stdout: stdout || "",
        stderr: stderr || "",
        durationMs,
        telemetryJson
      });
    });
  });
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (_) {}
}

function createStudioServer() {
  return http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    const pathname = parsedUrl.pathname;

    try {
      // Static SPA
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = fs.readFileSync(STUDIO_HTML, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }

      // Inventory + Guardrails
      if (req.method === "GET" && pathname === "/api/inventory") {
        sendJson(res, 200, buildInventory());
        return;
      }

      // Read file
      if (req.method === "GET" && pathname === "/api/file") {
        const target = safeResolve(parsedUrl.searchParams.get("path"));
        if (!target || !fs.existsSync(target.full) || !fs.statSync(target.full).isFile()) {
          sendJson(res, 404, { error: "Arquivo não encontrado." });
          return;
        }
        const content = fs.readFileSync(target.full, "utf8");
        const meta = target.rel.endsWith(".md") ? parseFrontmatter(content) : null;
        sendJson(res, 200, {
          item: classifyItem(target.rel, content, meta),
          content
        });
        return;
      }

      // Save file
      if (req.method === "PUT" && pathname === "/api/file") {
        const body = await readJsonBody(req);
        const target = safeResolve(body.path);
        if (!target || !fs.existsSync(target.full)) {
          sendJson(res, 404, { error: "Arquivo não encontrado." });
          return;
        }
        if (typeof body.content !== "string") {
          sendJson(res, 400, { error: "Conteúdo inválido." });
          return;
        }
        // Bloqueia salvar JSON ou JS sintaticamente quebrado
        if (target.rel.endsWith(".json")) {
          try { JSON.parse(body.content); } catch (e) {
            sendJson(res, 400, { error: `JSON inválido: ${e.message}` });
            return;
          }
        }
        if (target.rel.endsWith(".cjs") || target.rel.endsWith(".js")) {
          try {
            new vm.Script(body.content.replace(/^#!.*\r?\n/, ""), { filename: target.rel });
          } catch (e) {
            sendJson(res, 400, { error: `Erro de sintaxe JS: ${e.message}` });
            return;
          }
        }
        fs.writeFileSync(target.full, body.content, "utf8");
        const meta = target.rel.endsWith(".md") ? parseFrontmatter(body.content) : null;
        sendJson(res, 200, {
          saved: true,
          item: classifyItem(target.rel, body.content, meta)
        });
        return;
      }

      // Create new item
      if (req.method === "POST" && pathname === "/api/item") {
        const body = await readJsonBody(req);
        const tpl = buildTemplate(body.kind, body.slug, body.title, body);
        const target = safeResolve(tpl.rel);
        if (!target) {
          sendJson(res, 400, { error: "Caminho destino inválido." });
          return;
        }
        if (fs.existsSync(target.full)) {
          sendJson(res, 409, { error: `Já existe um item em ${target.rel}.` });
          return;
        }
        fs.mkdirSync(path.dirname(target.full), { recursive: true });
        fs.writeFileSync(target.full, tpl.content, "utf8");
        const meta = target.rel.endsWith(".md") ? parseFrontmatter(tpl.content) : null;
        sendJson(res, 201, {
          created: true,
          item: classifyItem(target.rel, tpl.content, meta),
          content: tpl.content
        });
        return;
      }

      // Delete item
      if (req.method === "DELETE" && pathname === "/api/item") {
        const target = safeResolve(parsedUrl.searchParams.get("path"));
        if (!target || !fs.existsSync(target.full)) {
          sendJson(res, 404, { error: "Arquivo não encontrado." });
          return;
        }
        if (PROTECTED_FILES.has(target.rel)) {
          sendJson(res, 403, { error: "Este arquivo é essencial ao Core e não pode ser excluído pelo Studio." });
          return;
        }
        fs.unlinkSync(target.full);
        // Remove pasta vazia de skill/stack se ficou órfã
        const parent = path.dirname(target.full);
        if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
          const parentRel = path.relative(KIT_ROOT, parent).replace(/\\/g, "/");
          if (parentRel.startsWith("stacks/") || parentRel.includes("/skills/")) {
            fs.rmdirSync(parent);
          }
        }
        sendJson(res, 200, { deleted: true, path: target.rel });
        return;
      }

      // Execute CLI action
      if (req.method === "POST" && pathname === "/api/cli") {
        const body = await readJsonBody(req);
        const result = await runCliAction(body);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: "Rota não encontrada." });
    } catch (err) {
      sendJson(res, 500, { error: err.message || "Erro interno no Studio." });
    }
  });
}

function startStudio(options = {}) {
  const port = Number(options.port) || 4789;
  const server = createStudioServer();

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`Porta ${port} em uso, tentando porta ${port + 1}...`);
      server.listen(port + 1, "127.0.0.1");
    } else {
      console.error("Erro ao iniciar AI-Kit Studio:", err.message);
      process.exit(1);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const url = `http://127.0.0.1:${addr.port}`;
    console.log(`\nAI-Kit Studio rodando em ${url}`);
    console.log(`Repositório gerenciado: ${KIT_ROOT}`);
    console.log("Pressione Ctrl+C para encerrar.\n");
    if (!options.noOpen) openBrowser(url);
  });

  return server;
}

if (require.main === module) {
  const noOpen = process.argv.includes("--no-open");
  const portIdx = process.argv.indexOf("--port");
  const port = portIdx > -1 ? Number(process.argv[portIdx + 1]) : 4789;
  startStudio({ port, noOpen });
}

module.exports = { startStudio, createStudioServer, buildInventory };
