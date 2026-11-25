---
name: aplicar-change
description: Orquestra a implementação de uma change do OpenSpec bloco a bloco em subagentes limpos, valida cada bloco com rodar-testes + telemetria determinística, executa verificação final e gera entrega.md + handoff.md. Use no lugar do /opsx:apply.
managed-by: ai-kit
tier_ideal: T2_CONSTRUTOR
esforco_ideal: medium
fallback_cota: T2_CONSTRUTOR
---

# Skill: aplicar-change

Você é o **coordenador** na conversa principal. **Nunca implemente código nem leia `proposal.md`, `design.md`, `specs/` ou arquivos de código**: cada bloco vai para o subagente `implementar-bloco` (contexto limpo). **Subagente não lança subagente**: `rodar-testes` e o subagente de revisão são chamados sempre por você.

## Regras do Coordenador
- **Sempre sequencial:** execute **1 bloco por vez** (nunca em paralelo, pois blocos alteram os mesmos arquivos).
- **Critério de bloco concluído:** (1) todas as tarefas do bloco estão `[x]` no `tasks.md`; (2) `rodar-testes` devolveu `PASSOU` para as suítes tocadas (cruzando `Suites_tocadas` com `ai-kit telemetry --target .`); e (3) `Test_integrity: OK`.
- **`SEM SUÍTE`:** aceito apenas quando a parte do projeto ainda não possui projeto/configuração de teste **e** o bloco não pedia criá-lo. Todo `SEM SUÍTE` aceito deve ir para `entrega.md`.
- **Circuit breaker (máx. 1 retry):** cada bloco tem a execução inicial e **no máximo 1 relançamento** (falha de teste, item `[ ]` restante ou resposta a `BLOQUEADO`). Na 2ª falha, pare, relate ao usuário e aguarde. Nunca entre em laço.
- **Limites de papel:** não gere `roteiro-teste.md`, não arquive, não faça commit nem push (salvo `ai.mode == claude` solo quando explicitamente pedido depois).

## Gate de Entrada
1. Identifique a change (argumento informado; senão rode `openspec list --json` — se houver só 1 ativa, use-a; senão pergunte).
2. Leia `.ai/project.yaml` e `openspec/changes/<change>/handoff.md`.
3. Confirme aprovação (`APROVADO PARA IMPLEMENTAÇÃO`, bloco anterior concluído ou devolução do QA). Sem aprovação, pergunte ao usuário se deseja prosseguir mesmo assim.
4. Mapeie os blocos via `grep -n '^## \|^- \[' openspec/changes/<change>/tasks.md` (sem ler o arquivo inteiro). Mostre 1 linha por bloco (`feito` | `pendente`).

## Loop de Implementação (todos os blocos pendentes exceto `Verificação`)
Para cada bloco pendente, em ordem:
1. Chame `implementar-bloco` passando:
   - nome da change e número/título do bloco;
   - `observacoes` acumuladas dos blocos anteriores desta sessão;
   - resposta do usuário (se veio de `BLOQUEADO`) ou falha do `rodar-testes` (se retry).
2. Acumule `armadilhas` (diferentes de `nenhuma`) e `observacoes` retornadas.
3. Trate o retorno na ordem:
   - `BLOQUEADO`: pare, mostre a dúvida/impedimento ao usuário e aguarde. Com a resposta, relance o bloco (consome o retry).
   - Confira via `grep` se todos os itens do bloco viraram `[x]`. Se sobrou `[ ]`, relance uma vez avisando; se persistir, pare e relate.
   - Rode `ai-kit telemetry --target .`: se `Test_integrity` acusar alerta (`skip`, supressão ou queda de assertions), relance o bloco exigindo correção imediata (consome o retry). Use a união de `Suites_tocadas` + `Suites_hint` (mapeadas em `commands.suites`) ao chamar `rodar-testes`.
   - `PASSOU` (ou `SEM SUÍTE` aceito): atualize `handoff.md` (< 40 linhas) com bloco concluído e próximo passo; informe 1 linha ao usuário (`Bloco N concluído: <resumo> | testes: <resumo literal>`) e siga para o próximo bloco.
   - `FALHOU`: relance `implementar-bloco` 1 vez com o relatório literal da falha e rode `rodar-testes` de novo. Se falhar novamente (ou se for falha de ambiente), pare e relate.

## Verificação Final (grupo `## Verificação` do `tasks.md`)
Execute somente após todos os blocos de implementação concluírem:
1. **V.1 Suíte completa:** chame `rodar-testes` com escopo `completo`. Se falhar por código, faça no máximo 1 correção via `implementar-bloco` + reteste completo; na 2ª falha (ou falha de ambiente), pare e relate.
2. **V.2 Revisão em subagente limpo:** descubra os arquivos alterados (`git status --short`). Verifique em `.ai/project.yaml` quais skills extras em `reviewers` casam com os caminhos tocados (além da obrigatória `.claude/skills/revisar-codigo/SKILL.md`). Lance **1** subagente `general-purpose` novo instruindo:
   - ler `revisar-codigo` e as skills extras aplicáveis + rules de `.claude/rules/dominio/` e `stacks/` que casem com os arquivos alterados;
   - corrigir **apenas** desvios mecânicos inequívocos de regra/padrão (se encontrar desvio de design ou regra de negócio, apenas reportar em `Para decidir` como bloqueante sem alterar comportamento);
   - não rodar suíte completa, não lançar subagentes e não editar `openspec/`.
   Se o subagente alterou algum arquivo, rode `rodar-testes` (`completo`) novamente (este resultado substitui o de V.1). Se reportou bloqueante de design/negócio, marque a entrega como bloqueada.
3. **V.3 Validação OpenSpec:** rode `openspec validate <change> --strict`. Falha de spec/design não deve ser mascarada: registre em `Divergências do design` e marque bloqueada.
4. **V.4 Telemetria, `entrega.md` e `handoff.md`:**
   - Execute `ai-kit telemetry --target .` como último comando antes de redigir `entrega.md`. Se `Test_integrity` falhar, marque a entrega como bloqueada.
   - Marque V.1–V.4 como `[x]` no `tasks.md` somente após cada item concluído.
   - Escreva `openspec/changes/<change>/entrega.md` no formato de `engenharia-core.md` (incluindo `Diff_Hash` e `Telemetria`), **apenas com evidências reais**.
   - Atualize `handoff.md` (< 40 linhas) com `Diff_Hash`, status `PRONTA_PARA_HOMOLOGACAO` (ou `BLOQUEADA`) e próximo comando: `homologar-change`.

## Modo Manual
Se o usuário pedir explicitamente só o próximo bloco (`/aplicar-change <change> bloco`), execute apenas o primeiro bloco pendente (incluindo `rodar-testes`, `telemetry` e atualização do `handoff.md`) e pare sem executar a `Verificação`.
