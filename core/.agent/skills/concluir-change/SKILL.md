---
name: concluir-change
description: Confere telemetria (Diff_Hash), entrega e homologação, sincroniza docs mapeados em project.yaml, arquiva no OpenSpec, atualiza plano, faz commit/push condicional e gera o prompt pronto da próxima fatia. Execução exclusivamente humana.
managed-by: ai-kit
tier_ideal: T3_OPERADOR
esforco_ideal: low
fallback_cota: T3_OPERADOR
---

# Skill: concluir-change

Ordem fixa: **conferir + telemetry → limpar sandbox → sincronizar docs → arquivar → atualizar plano → commit → push (se origin) → próxima fatia**. Só pare nos pontos marcados com **Pergunte**.

> **Regra Anti-Vibe-Coding:** esta skill promove a change para a fonte de verdade (`openspec/specs/`). Nunca deve ser executada em piloto automático sem confirmação humana explícita após revisão do `git diff`.

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
   - Antes de arquivar/commitar, peça confirmação humana final mostrando `Diff_Hash`, `diff_stat` e eventuais `Sensitive_touched`.
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

## 4. Commit e Push Condicional
1. Confira `git status --short` e garanta que `.tmp/` não está sendo incluído.
2. Faça o commit de tudo o que a change tocou no padrão:

```text
<tipo>: [<change>] <descrição curta no imperativo>

<2 a 4 linhas baseadas no proposal.md>
Arquiva a change no OpenSpec e atualiza o plano.
```

   (`<tipo>`: `feat`, `fix`, `refactor`, `docs`, `test` ou `chore`.)
3. Verifique se existe remote `origin`: `git remote get-url origin`.
   - **Se configurado:** execute `git push` (ou `git push -u origin <branch>` se sem upstream). Nunca use `--force`.
   - **Se NÃO existir `origin`:** conclua no commit e registre `Push: pulado (remote origin não configurado)`.

## 5. Resumo Final e Prompt da Próxima Fatia
1. Leia a próxima fatia pendente em `paths.queue_dir` (se existir); caso contrário, localize-a em `paths.plan` via `grep -n` + leitura pontual.
2. Apresente:
   - Change concluída + hash do commit + status do push;
   - Documentos sincronizados;
   - Próxima change/fatia prevista;
   - **PROMPT PRONTO** para copiar e colar na próxima sessão, indicando explicitamente se deve iniciar por `openspec-explore` ou `openspec-propose`.
