#!/usr/bin/env node
// managed-by: ai-kit
// Hook PreToolUse (Bash): compacta saída de build/test/lint preservando exit code.
// NUNCA auto-aprova comandos (respeita permissions.allow/deny) e recusa comandos compostos suspeitos.
"use strict";

const fs = require("fs");

const PNPM_OPCOES = "(?:(?:-C|--dir|--filter|-F)\\s+\\S+\\s+|(?:-r|--recursive)\\s+)*";

const FILTROS = [
  {
    nome: "dotnet test / vstest",
    comando: /^(dotnet\s+test|vstest\.console(\.exe)?)\b/i,
    padrao: "error|warn|fail|exception|passed!|failed!|total tests|^Test Run|passed:|skipped:|aprovad|com falha|Line coverage|Branch coverage|Coverage|threshold|\\[FAIL\\]|Assert|Shouldly"
  },
  {
    nome: "dotnet build / msbuild",
    comando: /^(dotnet\s+build|msbuild(\.exe)?)\b/i,
    padrao: "error|warning\\(s\\)|Build succeeded|Build FAILED|Error\\(s\\)"
  },
  {
    nome: "npm/yarn/pnpm test, vitest, jest ou playwright",
    comando: new RegExp(
      `^(npm|yarn)\\s+(run\\s+)?test\\b|^pnpm\\s+${PNPM_OPCOES}(run\\s+)?test\\b|^(npx\\s+|pnpm\\s+${PNPM_OPCOES}(exec\\s+)?)?(vitest|jest|playwright)\\b`,
      "i"
    ),
    padrao: "fail|error|✓|✗|passed|failed|skipped|Tests |Test Files |Coverage|threshold|Assert|Expected|Received"
  },
  {
    nome: "npm/yarn/pnpm build, lint ou tsc",
    comando: new RegExp(
      `^(npm|yarn)\\s+(run\\s+)?(build|lint|typecheck)\\b|^pnpm\\s+${PNPM_OPCOES}(run\\s+)?(build|lint|typecheck)\\b|^(npx\\s+|pnpm\\s+${PNPM_OPCOES}(exec\\s+)?)?(tsc|eslint)\\b`,
      "i"
    ),
    padrao: "error|warning|fail|✖|problems"
  }
];

const IGNORAR_SE_CONTEM = ["--watch", "-w ", "tail -f", "| cat", "> ", ">>", "$(", "`"];
const MAX_LINHAS = 80;

main();

function main() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return noop();
    const payload = JSON.parse(raw);
    const comando = payload?.tool_input?.command;
    if (payload.tool_name !== "Bash" || typeof comando !== "string") return noop();

    const filtro = encontrarFiltroSeguro(comando);
    if (!filtro) return noop();

    responderComando(construirComandoFiltrado(comando, filtro.padrao));
  } catch (_) {
    noop();
  }
}

function encontrarFiltroSeguro(comando) {
  if (IGNORAR_SE_CONTEM.some((trecho) => comando.includes(trecho))) return null;
  // Bloqueia pipes, ponto-e-vírgula, OR ou subshell; permite no máximo `cd <dir> && <cmd>`
  if (/[;|()\n]|\|\|/.test(comando)) return null;

  const partes = comando.split("&&").map((p) => p.trim()).filter(Boolean);
  if (partes.length === 0 || partes.length > 2) return null;
  if (partes.length === 2 && !/^cd\s+\S+$/i.test(partes[0])) return null;

  const alvo = partes[partes.length - 1].replace(/^(\w+=\S*\s+)+/, "");
  return FILTROS.find((item) => item.comando.test(alvo)) || null;
}

function construirComandoFiltrado(comandoOriginal, padraoGrep) {
  const arquivoTemp = "/tmp/claude-saida-$$.log";
  const comandoEscapado = comandoOriginal.replace(/'/g, "'\\''");
  const padraoEscapado = padraoGrep.replace(/'/g, "'\\''");
  return [
    `bash -c '${comandoEscapado}' > ${arquivoTemp} 2>&1`,
    "codigo_saida=$?",
    `filtrado=$(grep -E -i '${padraoEscapado}' ${arquivoTemp} | awk '!visto[$0]++' | tail -${MAX_LINHAS})`,
    `if [ -n "$filtrado" ]; then printf '%s\\n' "$filtrado"; elif [ $codigo_saida -ne 0 ]; then tail -30 ${arquivoTemp}; fi`,
    `echo "(exit $codigo_saida; log completo em ${arquivoTemp}: consulte com grep -n -A, nunca cat)"`,
    "exit $codigo_saida"
  ].join("; ");
}

function responderComando(comandoFiltrado) {
  // Não define auto-allow — mantém avaliação nativa de permissions.allow/deny do settings.json
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: comandoFiltrado }
    }
  }));
}

function noop() {
  process.stdout.write("{}");
}
