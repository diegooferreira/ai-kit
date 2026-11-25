// managed-by: ai-kit
// Hook PreToolUse (Write|Edit|MultiEdit): protege .env, arquivos managed-by: ai-kit e frontmatter paths: em dominio/.
"use strict";

const fs = require("fs");
const path = require("path");

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch (_) { return ""; }
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

function isCentralAiKitRepo() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return fs.existsSync(path.join(projectDir, "bin", "ai-kit.cjs"))
    && fs.existsSync(path.join(projectDir, "core", ".claude", "settings.json"));
}

function extractTargets(payload) {
  const input = payload?.tool_input || {};
  if (payload.tool_name === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.map((e) => ({
      filePath: String(e.file_path || input.file_path || ""),
      mode: "edit",
      oldStr: String(e.old_string || ""),
      newStr: String(e.new_string || "")
    }));
  }
  const filePath = String(input.file_path || input.path || "");
  if (!filePath) return [];
  if (payload.tool_name === "Write") {
    return [{ filePath, mode: "write", content: String(input.content || "") }];
  }
  return [{
    filePath,
    mode: "edit",
    oldStr: String(input.old_string || ""),
    newStr: String(input.new_string || "")
  }];
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { process.exit(0); }

  const insideCentralKit = isCentralAiKitRepo();
  const targets = extractTargets(payload);

  for (const t of targets) {
    if (!t.filePath) continue;
    const normalized = t.filePath.replace(/\\/g, "/");
    const baseName = path.basename(normalized);

    // 1. Bloquear escrita acidental em arquivos .env com segredos
    if (/^\.env(\..+)?$/i.test(baseName) && !/\.example$|\.sample$|\.template$/i.test(baseName)) {
      deny(`[ai-kit] Escrita bloqueada em "${baseName}". Use .env.example para templates e mantenha segredos fora da IA.`);
    }

    // 2. Proteger arquivos managed-by: ai-kit contra edição manual dentro de projetos destino
    if (!insideCentralKit && fs.existsSync(t.filePath)) {
      try {
        const current = fs.readFileSync(t.filePath, "utf8");
        if (current.includes("managed-by: ai-kit") || current.includes('"_managedBy": "ai-kit"')) {
          deny(`[ai-kit] "${normalized}" e gerenciado pelo Core (managed-by: ai-kit). Edite no repositorio central ai-kit e rode "ai-kit sync".`);
        }
      } catch (_) {}
    }

    // 3. Garantir frontmatter paths: em .claude/rules/dominio/ tanto em Write quanto em Edit/MultiEdit
    if (normalized.includes(".claude/rules/dominio/") && normalized.endsWith(".md")) {
      let resultingContent = "";
      if (t.mode === "write") {
        resultingContent = t.content;
      } else if (fs.existsSync(t.filePath)) {
        try {
          const current = fs.readFileSync(t.filePath, "utf8");
          resultingContent = t.oldStr ? current.replace(t.oldStr, t.newStr) : current;
        } catch (_) {}
      }
      if (resultingContent && !/^---\r?\n[\s\S]*?^paths:/m.test(resultingContent)) {
        deny(`[ai-kit] Toda regra em .claude/rules/dominio/ DEVE manter frontmatter YAML com "paths:" obrigatorio.`);
      }
    }
  }
}

main();
