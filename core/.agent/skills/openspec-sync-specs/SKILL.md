---
name: openspec-sync-specs
description: Mescla manualmente delta specs de uma change homologada para openspec/specs/ (use apenas fora do concluir-change, pois openspec archive já aplica as deltas).
managed-by: ai-kit
tier_ideal: T3_OPERADOR
esforco_ideal: low
fallback_cota: T3_OPERADOR
---

# Skill: openspec-sync-specs

## Execução
1. Leia os arquivos de delta em `openspec/changes/<change>/specs/`.
2. Para cada domínio afetado, mescle os requisitos adicionados, modificados ou removidos em `openspec/specs/<dominio>/spec.md`.
3. Preserve a formatação `GIVEN / WHEN / THEN` e remova marcações temporárias de delta (`ADDED`/`MODIFIED`).
4. Reporte em bullets curtos quais specs canônicas foram atualizadas.
