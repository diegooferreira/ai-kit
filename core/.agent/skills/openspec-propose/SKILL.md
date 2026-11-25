---
name: openspec-propose
description: Gera os artefatos OpenSpec (proposal.md com frontmatter de risco, design.md com critérios travados, delta specs/ e tasks.md em Blocos Atômicos) e executa a revisão arquitetural read-only antes de pedir aprovação.
managed-by: ai-kit
tier_ideal: T1_ARQUITETO
esforco_ideal: high
fallback_cota: T2_CONSTRUTOR
---

# Skill: openspec-propose

## Leitura Mínima Obrigatória
1. `.ai/project.yaml` e `openspec/config.yaml`
2. `openspec/changes/<change>/exploracao.md` (se existir)
3. `paths.decisions` (não reabrir ADRs aceitos) e `paths.technical_memory` (evitar armadilhas conhecidas)
4. Apenas a seção relevante de `paths.business_rules`, `openspec/specs/<dominio>/` e as rules aplicáveis em `.claude/rules/dominio/` e `.claude/rules/stacks/`

## Entregáveis em `openspec/changes/<change>/`
1. **`proposal.md`:** inicia obrigatoriamente com o frontmatter YAML de risco, seguido de contexto, objetivo, DENTRO/FORA do escopo, IDs de regras de negócio (`RN-XXX`) e ADRs relacionadas:
   ```yaml
   ---
   risk: low # low | medium | high (auth/RLS/migration destrutiva/financeiro/fiscal = high)
   needs_explore: false
   sensitive_paths: []
   ---
   ```
2. **`design.md`:** decisões técnicas, camada explícita de cada peça nova, contratos REST/eventos (rotas, verbos, DTOs, códigos HTTP, `ErrorResponse`), dono da validação de entrada, impacto em migrations, segurança/tenant e **critérios de aceite + invariantes de teste travados** (que o executor não pode enfraquecer).
3. **`specs/<dominio>/spec.md`:** delta specs verificáveis no formato `GIVEN / WHEN / THEN` (requisitos e cenários completos).
4. **`tasks.md`:** tarefas divididas em **Blocos Atômicos** (`## 1.`, `## 2.`, ..., 3 a 6 itens por bloco com testes inclusos), encerrando com o bloco fixo:

```markdown
## Verificação
- [ ] V.1 Suíte completa de build, lint e testes verdes
- [ ] V.2 Revisão de código e regras aplicáveis
- [ ] V.3 `openspec validate <change> --strict` sem erros
- [ ] V.4 Coletar `ai-kit telemetry`, gerar `entrega.md` (com `Diff_Hash`) e atualizar `handoff.md`
```

5. Se a change estiver listada em `paths.plan`, atualize o status dela para `Em andamento`.

## Revisão Automática (Read-Only)
Logo após gravar os entregáveis, **não peça aprovação ainda**:
1. Execute `revisar-proposta` sobre `<change>`:
   - Se o runtime suportar subagente isolado, delegue a um subagente de contexto limpo.
   - Caso contrário, faça leitura fria dos arquivos gravados seguindo estritamente o checklist de `revisar-proposta` (incluindo `openspec validate <change> --strict`).
2. **Nunca edite `proposal.md`, `design.md`, `specs/` ou `tasks.md` durante a revisão.**
3. Salve o relatório em `openspec/changes/<change>/revisao-proposta.md`.
4. Atualize `openspec/changes/<change>/handoff.md` (< 40 linhas) com:
   - Status: `AGUARDANDO_APROVACAO`
   - `Risk: <low|medium|high>`
   - Resumo da revisão (`X bloqueantes, Y importantes, Z sugestões | validate: OK/FALHOU`)
   - Próximo passo: decisão humana (ajustar apontamentos via `openspec-update-change` ou aprovar para `/aplicar-change <change>`).
5. Apresente ao usuário um resumo curto da proposta seguido do relatório completo da revisão e aguarde decisão.
