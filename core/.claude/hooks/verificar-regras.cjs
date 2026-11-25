#!/usr/bin/env node
// managed-by: ai-kit
// Hook PostToolUse (Write|Edit|MultiEdit): confere regras mecânicas e travas anti-vibe-coding nas linhas novas.
// Saída 0 = nada a apontar. Saída 2 = stderr volta para o Claude como aviso para correção imediata.
"use strict";

const fs = require("fs");
const path = require("path");

const CODE_EXTENSIONS = new Set([".cs", ".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const IGNORED_SEGMENTS = ["node_modules", "bin", "obj", "dist", "build", "wwwroot", "coverage", ".git", "migrations", ".tmp"];
const IGNORED_SUFFIXES = [".d.ts", ".min.js", ".g.cs", ".designer.cs", ".generated.cs"];

const CHECKS = [
  {
    message: "ternário: use if, guarda ou, no JSX, `condition && <Element />` (codigo.md)",
    extensions: [".cs", ".ts", ".tsx", ".js", ".jsx", ".mjs"],
    test: (line) => /[^?\s]\s+\?\s+\S.*\s:\s/.test(line) || /^\s*\?\s+\S/.test(line) || /[^?\s]\s+\?\s*\(?\s*$/.test(line)
  },
  {
    message: "`any`: use tipo explícito, `unknown` com estreitamento ou schema Zod (react/node)",
    extensions: [".ts", ".tsx"],
    test: (line) => /:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/.test(line)
  },
  {
    message: "cast forçado `as unknown as`: resolva o contrato/tipo ou valide com Zod",
    extensions: [".ts", ".tsx"],
    test: (line) => /\bas\s+unknown\s+as\b/.test(line)
  },
  {
    message: "`throw ex;` perde o stack trace: use `throw;` (excecoes.md)",
    extensions: [".cs"],
    test: (line) => /\bthrow\s+(?!new\b)\w+\s*;/.test(line)
  },
  {
    message: "catch vazio: capture só onde age (excecoes.md)",
    extensions: [".cs", ".ts", ".tsx", ".js", ".jsx", ".mjs"],
    test: (line) => /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)
  },
  {
    message: "bloqueio síncrono em código async: use `await` ponta a ponta (performance.md)",
    extensions: [".cs"],
    test: (line) => /\.Wait\(\s*\)|\.GetAwaiter\(\)\.GetResult\(\)|Async\([^)]*\)\.Result\b/.test(line)
  },
  {
    message: "`DateTime.Now`/`UtcNow` direto viola testabilidade: injete `TimeProvider` (.NET 8+) ou `IClock`/`IDateTimeProvider`",
    extensions: [".cs"],
    appliesTo: (filePath) => !isClockOrTestFile(filePath),
    test: (line) => /\bDateTime\.(Utc)?Now\b|\bDateTimeOffset\.(Utc)?Now\b/.test(line)
  },
  {
    message: "`Console.Write*` fora de `tools/`/`Program.cs`: use `ILogger` estruturado (logging.md)",
    extensions: [".cs"],
    appliesTo: (filePath) => !isCliOrTestFile(filePath),
    test: (line) => /\bConsole\.(WriteLine|Write|Error\.Write(Line)?)\b/.test(line)
  },
  {
    message: "valor fixo de cor ou espaçamento em px: use token semântico/escala Tailwind (react)",
    extensions: [".tsx", ".jsx"],
    inspectsRawLine: true,
    test: (line) => /-\[#[0-9a-fA-F]{3,8}\]|-\[\d+(\.\d+)?px\]|style=\{\{[^}]*#[0-9a-fA-F]{3,8}/.test(line)
  },
  {
    message: "`capitalize` viola sentence case em pt-BR: escreva o texto já na caixa correta (react)",
    extensions: [".tsx", ".jsx"],
    inspectsRawLine: true,
    test: (line) => /className=.*\bcapitalize\b/.test(line)
  },
  {
    message: "lógica na view da tela: estado, efeitos e chamadas vão para o hook `use<Tela>Page` (react)",
    extensions: [".tsx", ".jsx"],
    appliesTo: isScreenView,
    inspectsRawLine: true,
    test: (line) => /\buse(State|Effect|Reducer|Memo|Callback|Query|Mutation)\s*[(<]|from\s+['"][^'"]*\/services\//.test(line)
  },
  {
    message: "teste silenciado (skip/only): corrija o teste ou pause como BLOQUEADO; nunca pule testes (testes.md)",
    extensions: [".cs", ".ts", ".tsx", ".js", ".jsx", ".mjs"],
    appliesTo: isTestFile,
    inspectsRawLine: true,
    test: (line) => /\b(it|test|describe)\.(skip|only)\s*\(|\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(|\[(Fact|Theory|Test)\s*\([^)]*Skip\s*=|\[Ignore\b/.test(line)
  },
  {
    message: "supressão de tipagem/lint/compilador: corrija a causa raiz em vez de silenciar a ferramenta",
    extensions: [".cs", ".ts", ".tsx", ".js", ".jsx", ".mjs"],
    inspectsRawLine: true,
    test: (line) => /@ts-(ignore|nocheck|expect-error)|eslint-disable|biome-ignore|#pragma\s+warning\s+disable/.test(line)
  },
  {
    message: "espera fixa em teste (`Thread.Sleep`/`Task.Delay`/`waitForTimeout`): viole FIRST; aguarde evento/condição (testes.md)",
    extensions: [".cs", ".ts", ".tsx", ".js", ".jsx", ".mjs"],
    appliesTo: isTestFile,
    test: (line) => /\b(Thread\.Sleep|Task\.Delay|waitForTimeout)\s*\(/.test(line)
  }
];

main();

function main() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) process.exit(0);
    const payload = JSON.parse(raw);
    const snippets = collectSnippets(payload);
    const findings = snippets.flatMap(inspectSnippet);
    if (findings.length === 0) process.exit(0);
    reportFindings(findings);
    process.exit(2);
  } catch (_) {
    process.exit(0);
  }
}

function collectSnippets(payload) {
  const input = payload.tool_input || {};
  if (payload.tool_name === "Write") {
    return [{ filePath: input.file_path, newText: input.content, oldText: "" }];
  }
  if (payload.tool_name === "Edit") {
    return [{ filePath: input.file_path, newText: input.new_string, oldText: input.old_string }];
  }
  if (payload.tool_name === "MultiEdit") {
    const edits = input.edits || [];
    return edits.map((edit) => ({
      filePath: edit.file_path || input.file_path,
      newText: edit.new_string,
      oldText: edit.old_string
    }));
  }
  return [];
}

function countAssertions(text) {
  const matches = String(text || "").match(/\b(Assert\.|expect\s*\(|Should[A-Z]\w*|\.Should\(\))/g);
  return matches ? matches.length : 0;
}

function inspectSnippet(snippet) {
  if (!isCheckedFile(snippet.filePath) || typeof snippet.newText !== "string") return [];
  const extension = path.extname(snippet.filePath).toLowerCase();
  const previousLines = new Set(String(snippet.oldText || "").split(/\r?\n/).map((line) => line.trim()));
  const firstLineNumber = findFirstLineNumber(snippet.filePath, snippet.newText);
  const findings = [];

  snippet.newText.split(/\r?\n/).forEach((rawLine, index) => {
    if (previousLines.has(rawLine.trim())) return;
    const codeLine = stripStringsAndComments(rawLine);
    for (const check of CHECKS) {
      if (!check.extensions.includes(extension)) continue;
      if (check.appliesTo && !check.appliesTo(snippet.filePath)) continue;
      const line = check.inspectsRawLine ? rawLine : codeLine;
      if (check.test(line)) {
        findings.push(`${snippet.filePath}:${firstLineNumber + index} ${check.message}\n    ${rawLine.trim()}`);
      }
    }
  });

  // Trava determinística anti-enfraquecimento de testes existentes
  if (isTestFile(snippet.filePath) && snippet.oldText) {
    const before = countAssertions(snippet.oldText);
    const after = countAssertions(snippet.newText);
    if (before > 0 && after < before) {
      findings.push(
        `${snippet.filePath}:${firstLineNumber} redução de assertions em teste (${before} -> ${after}): proibido enfraquecer testes existentes para forçar build verde; se a regra mudou, pause como BLOQUEADO`
      );
    }
  }

  return findings;
}

function isTestFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  return /(^|\/)(tests?|__tests__|e2e|[^/]*\.Tests)\//i.test(normalized)
    || /\.(test|spec|e2e)\.[jt]sx?$/i.test(normalized)
    || /(Test|Tests|Spec)\.cs$/i.test(normalized);
}

function isClockOrTestFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  return /Clock|TimeProvider|Relogio|DateTimeProvider/i.test(normalized) || isTestFile(normalized);
}

function isCliOrTestFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  return /(^|\/)(tools|scripts|tests?|[^/]*\.Tests)\//i.test(normalized)
    || /\/Program\.cs$/i.test(normalized);
}

function isScreenView(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (/\.(test|spec)\.[jt]sx$/.test(normalized)) return false;
  return /Page\.[jt]sx$/.test(normalized) || /\/(pages|screens)\/[^/]+\.[jt]sx$/.test(normalized);
}

function isCheckedFile(filePath) {
  if (typeof filePath !== "string") return false;
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (IGNORED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false;
  if (normalized.split("/").some((segment) => IGNORED_SEGMENTS.includes(segment))) return false;
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function findFirstLineNumber(filePath, newText) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const offset = content.indexOf(newText);
    if (offset < 0) return 1;
    return content.slice(0, offset).split("\n").length;
  } catch (_) {
    return 1;
  }
}

function stripStringsAndComments(line) {
  const withoutStrings = line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\$]|\\.)*`/g, "``");
  if (/^\s*(\/\/|\*|\/\*)/.test(withoutStrings)) return "";
  return withoutStrings.replace(/\s\/\/.*$/, "");
}

function reportFindings(findings) {
  const header = "Regras mecânicas/anti-vibe-coding violadas no código recém-escrito (detalhes em .claude/rules/geral e stacks).\n"
    + "Corrija agora. Se for falso positivo justificado, siga e explique na resposta.\n";
  process.stderr.write(header + findings.map((f) => `- ${f}`).join("\n") + "\n");
}
