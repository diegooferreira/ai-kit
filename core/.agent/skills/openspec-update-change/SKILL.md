---
name: openspec-update-change
description: Atualiza pontualmente proposal, design, specs ou tasks de uma change ativa após feedback da revisão ou descoberta técnica.
managed-by: ai-kit
tier_ideal: T2_CONSTRUTOR
esforco_ideal: medium
fallback_cota: T3_OPERADOR
---

# Skill: openspec-update-change

## Execução
1. Leia `.ai/project.yaml`, `openspec/changes/<change>/handoff.md` e (se existir) `revisao-proposta.md`.
2. Carregue apenas os artefatos da change afetados pela alteração solicitada pelo usuário.
3. Aplique a atualização mantendo consistência cruzada entre `proposal.md` (incluindo frontmatter `risk`/`sensitive_paths`), `design.md`, `specs/` e `tasks.md` (**nunca apague tarefas `[x]` já concluídas**).
4. Rode `openspec validate <change> --strict` para confirmar integridade estrutural.
5. Registre o resumo da alteração no `handoff.md` (< 40 linhas) e informe se a change já pode ser aprovada ou retomada via `/aplicar-change`.
