# ai-kit v2.2.1 — Biblioteca Central Multi-IA + Studio + Worker Telegram

Repositório centralizado de skills, subagentes, rules modulares (`paths:`), hooks `.cjs` anti-vibe-coding, stack packs, **AI-Kit Studio** (painel web local) e **AI-Kit Worker** (orquestrador headless via Telegram usando Claude Code CLI + Antigravity CLI em `git worktree` isolado).

> **Zero dependências externas** — roda 100% com módulos nativos do Node.js (>= 18).

---

## 1. Instalação Única na Máquina (Windows PowerShell)

Extraia o `ai-kit` em `D:\Projetos\ai-kit` e registre o comando global:

```powershell
cd D:\Projetos\ai-kit
npm link
ai-kit --help
```

Para abrir o painel visual de gestão, edição de skills/rules, orçamento de tokens e gerador de templates/prompts:

```powershell
ai-kit studio
```

---

## 2. Setup Único do Worker Telegram (1ª vez)

Modelo adotado: **1 Bot + 1 Supergrupo Privado com Tópicos** (um tópico por projeto + `#geral`).

A configuração e o estado ficam salvos em **`<ai-kit>\.worker-data\`** (dentro da pasta do kit, fora do `C:\Users`, mas protegido no `.gitignore` para nunca commitar o token do Telegram).

### No Telegram (~3 minutos)
1. Abra o **`@BotFather`**, envie `/newbot` e guarde o **Token HTTP**.
2. Ainda no **`@BotFather`**, envie `/setprivacy` → selecione o seu bot → **`Disable`** (permite responder perguntas do `openspec-explore` em texto normal no tópico).
3. Crie um **Novo Grupo privado** contendo apenas **você e o bot** (ex.: `AI-Kit Control`).
4. Em **Editar Grupo** → ative **Tópicos (Fórum)**.
5. Em **Administradores** → promova o bot a **Admin** (com permissão para **Fixar Mensagens**).
6. Crie o tópico `#geral` e um tópico para cada projeto (ex.: `#qas`, `#contab-tools`, `#monitoramento`).

### No PowerShell
```powershell
ai-kit worker setup-telegram
```
1. Cole o **Token HTTP** do `@BotFather`.
2. Com o wizard escutando, envie no Telegram:
   - No tópico `#geral`: `/registrar geral`
   - Em cada tópico de projeto: `/registrar <slug> <caminho-completo>`  
     *(Ex.: `/registrar monitoramento D:\Projetos\monitoramento`)*
3. Pressione `Ctrl+C` ao terminar.
4. Valide o ambiente e ligue o daemon:

```powershell
ai-kit worker doctor
ai-kit worker start
```

> **Dica Windows:** nas configurações de energia, deixe **Suspender (Sleep) = Nunca** na tomada (pode desligar só o monitor).

---

## 3. Checklist: Configurar um Projeto Novo (Greenfield)

### Passo 1 — Estrutura e sincronização do kit
```powershell
mkdir meu-projeto
cd meu-projeto
git init
mkdir .ai, docs, docs\fila, .claude\rules\dominio -Force

# Inicializa OpenSpec
openspec init

# Sincroniza Core + Stack Packs desejados (veja `ai-kit list-stacks`)
ai-kit sync --mode multi-ia --stacks dotnet,react,postgresql,docker --target .
```

### Passo 2 — Arquivos mínimos obrigatórios na raiz e em `.ai/`
*(Dica: o `ai-kit studio` na aba **Projeto Novo** gera todos esses arquivos prontos para copiar com 1 clique.)*

1. **`.ai/project.yaml`** — contrato com `ai.mode`, `stacks`, `paths`, `commands` e `limits`.
2. **`.ai/modelos.md`** — matriz de tiers (`T1_ARQUITETO`, `T2_CONSTRUTOR`, `T3_OPERADOR`).
3. **`AGENTS.md`** (≤ 60 linhas) e **`CLAUDE.md`** (≤ 30 linhas).
4. **`.gitignore`** — garantir obrigatoriamente `.env`, `.env.*`, `!.env.example`, `.tmp/`, `.ai-kit-backup/` e `.worktrees/`.
5. **Macro-fundações em `docs/`** — `APPLICATION_MAP.md`, `docs/plano.md`, `docs/decisoes.md`, `docs/memoria-tecnica.md`, `docs/pendencias.md` e `docs/regras-de-negocio.md`.

### Passo 3 — Validar e fazer o commit inicial
```powershell
ai-kit doctor --strict --target .
git add .
git commit -m "chore: bootstrap inicial com ai-kit v2.2"
```

### Passo 4 — Plugar o novo projeto no Worker Telegram
1. Crie um novo tópico no Supergrupo (ex.: `#meu-projeto`).
2. Rode `ai-kit worker setup-telegram` (aperte `Enter` para manter o token atual) e envie no novo tópico:
   `/registrar meu-projeto D:\Projetos\meu-projeto`
3. Pressione `Ctrl+C` e reinicie `ai-kit worker start`.

---

## 4. Checklist: Adotar em Projeto Existente (Brownfield)

Nunca migre direto na `main`. Use uma branch dedicada e `--adopt`:

```powershell
cd D:\Projetos\projeto-existente
git checkout -b chore/adotar-ai-kit

# 1. Simule primeiro sem gravar nada
ai-kit sync --adopt --dry-run --mode multi-ia --stacks dotnet,react,mariadb --target .

# 2. Aplique (faz backup de arquivos customizados em .ai-kit-backup/)
ai-kit sync --adopt --mode multi-ia --stacks dotnet,react,mariadb --target .

# 3. Veja o que falta ajustar (.ai/project.yaml, AGENTS.md, CLAUDE.md, .gitignore)
ai-kit doctor --target .
```

Após criar/ajustar `.ai/project.yaml`, `APPLICATION_MAP.md` e as regras de domínio em `.claude/rules/dominio/*.md` (sempre com frontmatter `paths:` obrigatório — prompt pronto disponível na aba **Projeto Existente** do `ai-kit studio`):

```powershell
# 4. Limpa órfãos antigos e valida no modo estrito
ai-kit sync --prune --target .
ai-kit doctor --strict --target .
```

Garanta `.tmp/`, `.ai-kit-backup/` e `.worktrees/` no `.gitignore`, revise o diff, faça o merge na `main` e registre o tópico no Telegram.

---

## 5. Operação Diária (Celular + PC)

### Comandos no Tópico do Projeto (Telegram)

| Comando / Botão | O que faz |
|---|---|
| `/fila` | Lista as próximas fatias pendentes em `docs/fila` ou `docs/plano.md`. |
| `/explorar <slug>` | Cria `git worktree`, roda `openspec-explore` no `agy` (`--effort high`); responda dúvidas em texto livre no tópico. |
| `/iniciar <slug>` | Cria `git worktree`, roda `openspec-propose` + `revisar-proposta` no `agy` e envia resumo + botão `[✅ Aprovar Spec e Implementar]`. |
| `/status` ou `[↻ Atualizar]` | Consulta o SO na hora: PID vivo, subagente ativo (`implementar-bloco`/`rodar-testes`), último evento, cota 5h/7d do Claude e arquivos no worktree/VS Code. |
| `[✅ Permitir 1x]` / `[❌ Negar]` | Aprovação síncrona fail-closed (timeout 15 min) quando o Claude precisa rodar algo fora da whitelist do `settings.json`. |
| `/homologar` | Roda `homologar-change` no `agy` + `ai-kit telemetry` e estaciona em **`✅ PRONTO PARA REVISÃO NO PC`**. |
| `/telemetria` | Executa `ai-kit telemetry` no worktree (`Diff_Hash`, `Test_integrity`, `Sensitive_touched`, `diff_stat`). |
| `/logs` | Exibe as últimas 25 linhas do agente ativo. |
| `/pausar` · `/retomar` · `/abortar` | Pausa após a etapa atual, retoma pós-cota/queda via `handoff.md` ou mata a árvore de processos preservando o worktree. |

### Ações Exclusivas no PC (Regras Anti-Vibe-Coding)
- **Proposta classificada como `risk: high`** (auth, permissões, multi-tenant/RLS, migrations destrutivas, financeiro/fiscal): aprovação mobile fica bloqueada. Revise `proposal.md`/`design.md` no monitor e libere com:
  ```powershell
  ai-kit worker approve <slug-do-projeto>
  ```
  Depois envie `/retomar` no tópico do Telegram.
- **Fechar e integrar na `main`:** quando chegar o aviso `✅ PRONTO PARA REVISÃO NO PC`, abra o worktree no VS Code, inspecione o `git diff` e rode **`concluir-change`** no PC — ele valida `Diff_Hash`, sincroniza docs, arquiva no OpenSpec, commita, faz `git merge --no-ff` na `main`, executa `git push` (se houver `origin`) e remove o worktree + branch local automaticamente.

---

## 6. Referência Rápida da CLI

| Comando | Descrição |
|---|---|
| `ai-kit studio [--port 4789]` | Painel web local (catálogo, editor, guardrails, tokens, CLI e playbooks). |
| `ai-kit sync [--adopt] [--prune] [--dry-run] --target .` | Sincroniza Core + Stack Packs conforme `.ai/project.yaml`. |
| `ai-kit doctor [--strict] --target .` | Valida integridade do projeto contra os padrões e guardrails v2.2. |
| `ai-kit telemetry [--json] --target .` | Telemetria determinística do git (`Diff_Hash`, integridade de testes e áreas sensíveis). |
| `ai-kit list-stacks` | Lista Stack Packs disponíveis com estimativa de tokens. |
| `ai-kit worker <setup-telegram\|add-project\|start\|status\|approve\|doctor>` | Gerencia o daemon local do Worker Multi-IA via Telegram. |
