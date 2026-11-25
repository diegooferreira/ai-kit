---
name: openspec-explore
description: Descoberta estruturada de requisitos, impactos técnicos, classificação de risco, ADRs e armadilhas antes de propor uma change.
managed-by: ai-kit
tier_ideal: T1_ARQUITETO
esforco_ideal: high
fallback_cota: T2_CONSTRUTOR
---

# Skill: openspec-explore

## Leitura Mínima Obrigatória
1. `.ai/project.yaml` (ponteiros `paths.*`, `stacks` e `domain_rules`)
2. Fatia alvo em `paths.queue_dir` ou `paths.plan` (ou demanda informada pelo usuário)
3. `paths.application_map`, `paths.technical_memory` e `paths.decisions` (sem varrer o repositório inteiro)
4. Apenas as specs canônicas (`openspec/specs/<dominio>/`) e trechos de `paths.business_rules` ligados ao tema

## Execução
1. Mapeie arquivos, módulos, tabelas, contratos e regras de negócio potencialmente impactados. Use `grep`/busca direcionada e leitura com `offset`/`limit`.
2. Identifique ambiguidades de negócio, decisões técnicas abertas e possíveis conflitos com ADRs ou `paths.technical_memory`; nunca chute regras.
3. Classifique preliminarmente o risco da change (`low` | `medium` | `high`) e liste eventuais `sensitive_paths` (auth, permissões, multi-tenant/RLS, migrations, financeiro, fiscal/regulatório).
4. Registre dúvidas bloqueantes em `paths.open_questions` ou conduza perguntas objetivas e curtas ao usuário.
5. Grave o resultado em `openspec/changes/<change>/exploracao.md` contendo:
   - Objetivo e fronteira (`DENTRO` / `FORA` do escopo)
   - Classificação preliminar de risco (`risk` + `sensitive_paths`)
   - Impactos técnicos (backend, banco/migrations, frontend, integrações, segurança/tenant)
   - Riscos, armadilhas de `paths.technical_memory` aplicáveis e pendências abertas
   - Veredito: pronto para `openspec-propose` ou bloqueado por dúvida.
6. Atualize `openspec/changes/<change>/handoff.md` (< 40 linhas) com o estado `01 — Explorar`.
