---
name: openspec-archive-change
description: Arquiva via CLI uma change concluída para openspec/changes/archive/ (prefira concluir-change para fechar docs, plano e commit).
managed-by: ai-kit
tier_ideal: T3_OPERADOR
esforco_ideal: low
fallback_cota: T3_OPERADOR
---

# Skill: openspec-archive-change

## Execução
1. Confirme que `handoff.md` contém selo `HOMOLOGADO`, rode `ai-kit telemetry --target .` (confirmando `Test_integrity: OK`) e rode `openspec validate <change> --strict`.
2. Execute `openspec archive <change> --yes` (nunca mova pastas de `openspec/` manualmente).
3. Confira via `openspec list` que a change não aparece mais ativa.
