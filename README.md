# ai-kit v1.0 — Biblioteca Central Multi-IA (OpenSpec SDD)

Repositório centralizado de skills, subagentes, rules modulares (`paths:`), hooks `.cjs` anti-vibe-coding, stack packs e **AI-Kit Studio** (painel web local para gestão, orçamento de tokens e playbooks Greenfield/Brownfield).

> **Zero dependências externas** — roda 100% com módulos nativos do Node.js (`>= 18.0.0`).

## Instalação (Windows PowerShell)

Clone o repositório e registre o comando global `ai-kit`:

```powershell
git clone https://github.com/diegooferreira/ai-kit.git
cd ai-kit
npm link
ai-kit --help
```

Para abrir o Studio diretamente sem `npm link`:

```powershell
npm run studio
```

## Comandos Principais

| Comando | O que faz |
|---|---|
| `ai-kit studio [--port 4789] [--no-open]` | Abre o painel web local para gerenciar skills/rules/hooks/stacks, medir tokens, rodar `doctor`/`telemetry`/`sync` e copiar playbooks Greenfield & Brownfield. |
| `ai-kit sync --target <dir>` | Sincroniza Core (`.agent`, `.claude`, `shared`) + Stack Packs conforme `.ai/project.yaml`. |
| `ai-kit sync --adopt --target <dir>` | Migração de projeto existente: faz backup em `.ai-kit-backup/` antes de sobrescrever arquivos não gerenciados. |
| `ai-kit sync --prune --target <dir>` | Remove arquivos órfãos `managed-by: ai-kit` de stacks desativadas ou itens removidos do core. |
| `ai-kit doctor --strict --target <dir>` | Valida contrato, ponteiros, frontmatter `paths:`, hooks `.cjs`, blindagens, `.gitignore` e zero redundâncias. |
| `ai-kit telemetry --target <dir> [--json]` | Gera telemetria determinística do git (`diff_hash`, caminhos sensíveis, integridade de testes e `suites_hint`). |
| `ai-kit list-stacks` | Lista os Stack Packs disponíveis com quantidade de arquivos e estimativa de tokens. |

## Opções Comuns

| Opção | Descrição |
|---|---|
| `--target <dir>` | Diretório do projeto alvo (padrão: `.`). |
| `--mode <modo>` | Modo de operação: `multi-ia`, `claude` ou `gemini` (padrão: lê `.ai/project.yaml`). |
| `--stacks <a,b,c>` | Stacks separadas por vírgula (padrão: lê `.ai/project.yaml`). |
| `--adopt` | Faz backup de arquivos não gerenciados antes de substituir. |
| `--prune` | (`sync`) Remove arquivos órfãos `managed-by: ai-kit` fora do plano atual. |
| `--dry-run` | Mostra o que seria feito sem gravar arquivos. |
| `--strict` | (`doctor`) Trata alertas (`WARN`) como erro (`exit 1`). |
| `--json` | (`telemetry`) Imprime saída estruturada em JSON. |
| `--port <numero>` | (`studio`) Porta local do Studio (padrão: `4789`). |
| `--no-open` | (`studio`) Não abre o navegador automaticamente. |

## Exemplos de Uso

```powershell
ai-kit studio
ai-kit sync --target . --prune
ai-kit sync --adopt --mode multi-ia --stacks dotnet,react,postgresql --target .
ai-kit doctor --strict --target .
ai-kit telemetry --target . --json
```

## Stack Packs Disponíveis

- `docker`
- `dotnet`
- `mariadb`
- `node`
- `playwright`
- `postgresql`
- `react`
- `sqlite`

## Endurecimentos Anti-Vibe-Coding (v1.0)

1. **Filtro de saída sem bypass (`filtrar-saida-testes.cjs`):** recusa comandos compostos (`;`, `|`, `||`, subshell), remove auto-aprovação (`permissionDecision: "allow"`) e garante fallback de `tail -30` em erro sem match.
2. **Proteção completa de arquivos (`proteger-arquivos.cjs`):** valida `Write`, `Edit` e `MultiEdit` para exigir `paths:` em `.claude/rules/dominio/`, proteger `.env` e arquivos `managed-by: ai-kit`.
3. **Travas mecânicas anti-sabotagem (`verificar-regras.cjs`):** bloqueia `.skip`/`only`/`[Fact(Skip=`, `@ts-ignore`/`eslint-disable`/`#pragma warning disable`, `as unknown as`, esperas fixas em testes e redução do número de assertions em testes existentes.
4. **Permissões fechadas (`settings.json`):** bloqueia `Write` e `MultiEdit` (além de `Edit`) em `proposal.md`/`design.md`/`specs/` no modo `multi-ia`, fecha wildcards abertos de `pnpm` e ajusta `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` para `55`.
5. **Telemetria determinística (`ai-kit telemetry`) + `risk` frontmatter:** `entrega.md` registra `Diff_Hash` conferido antes do `concluir-change`, e `proposal.md` exige classificação `risk: low | medium | high`.
6. **Economia de tokens:** `retomar-change` em fonte única (`core/shared/`), remoção de blocos repetidos de preflight nas skills, `testes.md` carregado apenas em arquivos de teste e `revisar-ui` sem duplicação de `react-tailwind.md`.
