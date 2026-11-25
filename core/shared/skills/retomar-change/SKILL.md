---
name: retomar-change
description: Retomada fria (< 2.000 tokens) para qualquer etapa do fluxo OpenSpec SDD após estouro de cota, troca de IA ou queda no meio de um bloco (com reconciliação de tasks.md).
managed-by: ai-kit
tier_ideal: T2_CONSTRUTOR
esforco_ideal: low
fallback_cota: T3_OPERADOR
---

# Skill: retomar-change (Fonte Única — Gemini & Claude)

Retoma uma change ativa sem reler histórico de chat nem varrer o repositório, perguntando apenas os parâmetros mínimos da etapa em que parou — e reconciliando `tasks.md` contra o código quando houve queda no meio da implementação.

## Regras Rígidas de Economia de Tokens
- **PROIBIDO** ler `docs/` inteira ou explorar pastas de código antes de confirmar os parâmetros com o usuário.
- Leia inicialmente **APENAS**:
  1. `.ai/project.yaml` (comandos, modo de IA e ponteiros)
  2. Listagem rasa de `openspec/changes/` (ignorando `archive/`)
  3. `openspec/changes/<change>/handoff.md` (se houver apenas 1 change ativa)
  4. `git status --short` e `git log -n 3 --oneline`

## Passo 1 — Auto-Detecção + 1 Rodada Curta de Confirmação
Apresente o resumo detectado em até 6 linhas e faça **uma única pergunta estruturada** (com defaults preenchidos):

1. **Change alvo:** (auto-preenchida se houver só 1 pasta ativa em `openspec/changes/`).
2. **Etapa atual:** (lida do `handoff.md`: `01-Explorar` | `02-Propor` | `03-Revisar` | `04-Aplicar` | `05-Homologar` | `06-Concluir`).
3. **Modo de retomada:**
   - `(A)` **Continuar aqui agora** (esta sessão assume a execução imediatamente — mesma IA pós-reset ou outra IA em fallback).
   - `(B)` **Gerar prompt compacto de passagem** (montar o bloco de retomada para colar em outra IA/ferramenta).
4. **Parâmetros específicos da Etapa detectada** (pergunte SOMENTE os da linha aplicável):

| Etapa | Parâmetros Específicos |
|---|---|
| **01 — Explorar** | Foco pendente; se dúvidas vão para `paths.open_questions` ou são respondidas agora. |
| **02 — Propor** | Artefatos já existentes (`proposal`, `design`, `specs`, `tasks`) para gerar APENAS os faltantes. |
| **03 — Revisar Proposta** | Rodar `revisar-proposta` completo ou aplicar ajustes aprovados via `openspec-update-change`. |
| **04 — Aplicar Change** | Próximo bloco `[ ]` em `tasks.md`; se houve queda no meio (reconciliar `[x]`/`[ ]` via `git diff --stat`); limite de blocos (`todos` ou `1 bloco`). |
| **05 — Homologar** | Próximo cenário pendente no `roteiro-teste.md`; se o ambiente local está no ar; foco (`IA-CLI`/`IA-UI` ou humano). |
| **06 — Concluir** | Passos restantes (`telemetry`, `sanity_build`, sync docs, `archive`, commit/push, próxima fatia). |

## Passo 2 — Execução Cirúrgica
- **Reconciliação da Etapa 04 (queda no meio do bloco):**
  1. Leia `tasks.md`, `design.md` e `git diff --stat`.
  2. Verifique via `grep`/LSP o que existe de fato no código e rode testes pontuais do que foi alterado.
  3. Acerte `tasks.md`: `[x]` só para o que está implementado e com teste verde; tarefa pela metade volta para `[ ]`.
  4. Relate em poucas linhas (Concluído / Pendente / Quebrado) e devolva ao `/aplicar-change <change>`.
- Nos demais casos, carregue **somente** os arquivos listados no `handoff.md` e execute a próxima unidade pendente.
- Ao encerrar, atualize obrigatoriamente `openspec/changes/<change>/handoff.md` (< 40 linhas).
