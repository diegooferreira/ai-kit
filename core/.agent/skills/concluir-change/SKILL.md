---
name: concluir-change
description: Confere telemetria (Diff_Hash), entrega e homologação, sincroniza docs mapeados em project.yaml, arquiva no OpenSpec, atualiza plano, faz commit, sincroniza branch/worktree para a main, faz push condicional e gera o prompt pronto da próxima fatia. Execução exclusivamente humana.
managed-by: ai-kit
tier_ideal: T3_OPERADOR
esforco_ideal: low
fallback_cota: T3_OPERADOR
---

# Skill: concluir-change

Ordem fixa: **conferir + telemetry → limpar sandbox → sincronizar docs → arquivar → atualizar plano → commit → merge na main (se worktree/branch) → push (se origin) → limpar worktree → próxima fatia**. Só pare nos pontos marcados com **Pergunte**.

> **Regra Anti-Vibe-Coding:** esta skill promove a change para a fonte de verdade (`openspec/specs/`) e sincroniza o código para a `main`. Nunca deve ser executada em piloto automático sem confirmação humana explícita após revisão do `git diff`.

## 1. Conferir antes de fechar
1. Leia `.ai/project.yaml` e identifique a change (argumento ou `openspec list`; se houver mais de uma ativa, **Pergunte**).
2. **`entrega.md`:** confira `Status: pronta para arquivar`, o `Diff_Hash` e o atestado literal de testes do `rodar-testes`. Se ausente ou bloqueada, pare e devolva ao `/aplicar-change`.
3. **Telemetria determinística:** execute `ai-kit telemetry --target .`.
   - Se `Test_integrity` apontar alerta (`skip`, supressão ou queda de assertions), pare imediatamente e devolva ao `/aplicar-change`.
   - Se `Diff_Hash` divergir do registrado em `entrega.md` (código alterado depois do último teste), pare e informe ao usuário que é preciso revalidar.
   - Se `Sensitive_touched` não estiver vazio, destaque os caminhos sensíveis na confirmação final.
4. **`tasks.md`:** todos os itens devem estar `[x]`. Se houver `[ ]`, liste e **Pergunte** antes de seguir.
5. **Validação:** execute `openspec validate <change> --strict`.
6. **Sanity build:** se `commands.sanity_build` estiver definido em `.ai/project.yaml`, execute-o. Se falhar, pare imediatamente e devolva ao `/aplicar-change`.
7. **Homologação:** leia `roteiro-teste.md` (se existir).
   - Se houver cenário `IA-CLI`/`IA-UI` sem `[VALIDADO PELA IA - OK]`, pare e sugira rodar `homologar-change`.
   - Se houver cenários `HUMANO-UI`/`HUMANO-EXTERNO`, **Pergunte** a confirmação humana deles.
   - Antes de arquivar/commitar/fazer merge na `main`, peça confirmação humana final mostrando `Diff_Hash`, `diff_stat`, branch atual e eventuais `Sensitive_touched`.
8. **Sandbox residual:** se `<paths.qa_sandbox>/<change>/` ainda existir, remova agora sem perguntar.

## 2. Sincronizar Documentação (orientado por `.ai/project.yaml`)
Economize contexto: use `entrega.md`, `handoff.md`, `git status --short` e `git diff --stat`. Atualize apenas o que mudou:
- `paths.application_map`: incorporar novos módulos, rotas, tabelas, eventos ou comandos da seção `Mapa` de `entrega.md`.
- `paths.technical_memory`: incorporar `Armadilhas e aprendizados técnicos` de `entrega.md` com `(Ref: <change>)`, se diferente de `nenhum`.
- `paths.open_questions`: remover dúvidas resolvidas e registrar novas, se houver.
- `paths.decisions`: atualizar status de decisões efetivadas pela change.
- `README.md` / `AGENTS.md` / `CLAUDE.md`: somente se a change alterou comando essencial, estrutura ou pré-requisito.
- `extra_docs_sync` (se listado em `.ai/project.yaml`): aplicar apenas quando a condição `when` se cumprir.
- Nunca edite `openspec/specs/` manualmente (`openspec archive` já aplica as delta specs).

## 3. Arquivar e Atualizar Plano
1. Execute `openspec archive <change> --yes`. Confira via `openspec list` que a change não aparece mais ativa.
2. Em `paths.plan`, marque a fatia/change como `Concluída` com a data atual, registre 1 linha no histórico e aponte a próxima fatia prevista.

## 4. Commit, Sincronização para a `main` e Push Condicional
1. Confira `git status --short` e garanta que `.tmp/` e `.worktrees/` não estão sendo incluídos.
2. Faça o commit na branch atual de tudo o que a change tocou no padrão:

```text
<tipo>: [<change>] <descrição curta no imperativo>

<2 a 4 linhas baseadas no proposal.md>
Arquiva a change no OpenSpec e atualiza o plano.
```

   (`<tipo>`: `feat`, `fix`, `refactor`, `docs`, `test` ou `chore`.)

3. **Sincronização com a branch principal (`main` / `master`):**
   - Descubra a branch atual (`git rev-parse --abbrev-ref HEAD`) e a branch principal do repositório (`main`, ou `master` se `main` não existir).
   - **Se estiver numa branch dedicada de change (ex.: `feat/<change>`) ou dentro de um `git worktree`:**
     1. Localize o diretório raiz do checkout principal (`git worktree list --porcelain` → primeiro `worktree`).
     2. Confira se o checkout principal está limpo (`git -C <main_root> status --porcelain`). Se houver arquivos sujos não commitados na `main`, **pare** e peça ao usuário para limpar/commitar antes do merge.
     3. Garanta que o checkout principal está na branch principal (`git -C <main_root> checkout <main_branch>`) e execute o merge preservando histórico:
        `git -C <main_root> merge --no-ff <branch_da_change> -m "merge: [<change>] integra branch na <main_branch>"`
     4. Se ocorrer conflito de merge, execute `git -C <main_root> merge --abort`, **pare** e informe os arquivos conflitantes ao usuário.
     5. Após merge verde na `main`, remova o worktree (se aplicável: `git -C <main_root> worktree remove <caminho_worktree>`) e apague a branch local integrada (`git -C <main_root> branch -d <branch_da_change>`).
4. **Push condicional (sempre a partir da branch principal já atualizada):**
   - Verifique se existe remote `origin`: `git remote get-url origin`.
   - **Se configurado:** execute `git push` (ou `git push -u origin <main_branch>` se sem upstream). Nunca use `--force`.
   - **Se NÃO existir `origin`:** conclua no commit/merge e registre `Push: pulado (remote origin não configurado)`.

## 5. Resumo Final e Prompt da Próxima Fatia
1. Leia a próxima fatia pendente em `paths.queue_dir` (se existir); caso contrário, localize-a em `paths.plan` via `grep -n` + leitura pontual.
2. Apresente:
   - Change concluída + hash do commit/merge na `main` + status do worktree/push;
   - Documentos sincronizados;
   - Próxima change/fatia prevista;
   - **PROMPT PRONTO** para copiar e colar na próxima sessão (ou comando `/iniciar <slug>` no Telegram), indicando explicitamente se deve iniciar por `openspec-explore` ou `openspec-propose`.
