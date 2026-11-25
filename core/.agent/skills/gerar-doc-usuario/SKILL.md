---
name: gerar-doc-usuario
description: Gera ou atualiza documentação funcional voltada ao usuário final a partir de openspec/specs/ e proposal/design.
managed-by: ai-kit
tier_ideal: T2_CONSTRUTOR
esforco_ideal: low
fallback_cota: T3_OPERADOR
---

# Skill: gerar-doc-usuario

## Execução
1. Leia `.ai/project.yaml` e apenas as specs canônicas (`openspec/specs/<modulo>/`) ou a change solicitada.
2. Traduza regras técnicas e cenários `GIVEN / WHEN / THEN` para linguagem clara de usuário final (sem jargão de código, tabelas SQL ou nomes de endpoints).
3. Estruture em: **Objetivo**, **Quem pode usar**, **Passo a passo**, **Regras e validações importantes** e **Perguntas frequentes**.
4. Salve no diretório de documentação de usuário definido pelo projeto (padrão: `docs/usuario/<modulo>.md`).
