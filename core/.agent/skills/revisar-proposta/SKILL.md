---
name: revisar-proposta
description: Auditoria arquitetural read-only de proposal.md (incluindo risco), design.md, delta specs e tasks.md contra regras de arquitetura, domínio, ADRs, memória técnica e openspec validate --strict.
managed-by: ai-kit
tier_ideal: T1_ARQUITETO
esforco_ideal: high
fallback_cota: none
---

# Skill: revisar-proposta

Lê a proposta como um arquiteto antes de qualquer linha de código existir: é o ponto mais barato para corrigir decisão errada. **Estritamente read-only sobre os artefatos da change** — não altere `proposal.md`, `design.md`, `specs/` nem `tasks.md`, a menos que o usuário peça depois de ver o relatório.

> **Gate Crítico (`fallback_cota: none`):** erro neste gate contamina toda a implementação. Nunca rebaixe para modelo leve.

## Leitura Mínima Obrigatória
1. `.ai/project.yaml` e `openspec/config.yaml` (stack, princípios fixos e invariantes).
2. `openspec/changes/<change>/proposal.md`, `design.md`, `tasks.md` e delta `specs/`.
3. `paths.decisions` (ADRs), `paths.technical_memory` e apenas as specs existentes em `openspec/specs/` que tocam a mesma área.
4. Rules aplicáveis (leitura econômica): apenas as rules em `paths.domain_rules_dir` e `.claude/rules/stacks/` que se aplicam às camadas tocadas pela change.

## Passos
1. Leia os artefatos acima.
2. Execute `openspec validate <change> --strict` no terminal.
3. Aplique o checklist na ordem abaixo.
4. Grave/atualize `openspec/changes/<change>/revisao-proposta.md` e devolva o relatório ao usuário. **Nunca sele `APROVADO PARA IMPLEMENTAÇÃO` sem confirmação explícita do usuário** (quando houver 0 bloqueantes e `validate` passar, apenas sinalize que está pronta para aprovação).

## Checklist

### 1. Escopo, negócio, risco e rastreabilidade
- Responde à demanda sem inflar escopo não discutido; fronteiras `DENTRO`/`FORA` claras.
- `proposal.md` contém frontmatter `risk` (`low` | `medium` | `high`) e `sensitive_paths` coerentes com o impacto real (auth, permissões, multi-tenant/RLS, migrations destrutivas, cálculos financeiros ou regras fiscais/regulatórias **não podem** ser `low`).
- Não contraria `paths.business_rules` nem ADRs aceitas em `paths.decisions`.
- Ambiguidades não resolvidas foram registradas em `paths.open_questions` em vez de empurradas para a implementação.

### 2. Arquitetura, camadas e memória técnica
- `design.md` define explicitamente a camada de cada peça nova conforme as rules da stack.
- Nenhum UseCase planejado chamando outro UseCase; nenhuma regra de negócio planejada para controller, rota HTTP ou view de tela.
- Nenhuma violação de invariantes de domínio (`paths.domain_rules_dir`) nem repetição de armadilha registrada em `paths.technical_memory`.

### 3. Contratos, erros e validação
- Contratos REST/eventos especificados (rotas, verbos, request/response, códigos HTTP), não apenas em prosa vaga.
- Erros esperados têm tratamento e `ErrorResponse` previstos, não só caminho feliz.
- Validação de entrada tem dono definido (`IValidator<TRequest>`, schema Zod etc.).

### 4. Consistência com o que já existe
- Não duplica UseCase, Service, endpoint ou tabela já existente em `openspec/specs/` ou `paths.application_map`.
- Respeita princípios fixos de `openspec/config.yaml` (exceções precisam estar explícitas e justificadas).

### 5. Testabilidade, granularidade e `tasks.md`
- Todo cenário `GIVEN / WHEN / THEN` das specs tem cobertura em `tasks.md` e invariantes de teste travados em `design.md`.
- Blocos atômicos (3 a 6 tarefas por bloco), cada bloco incluindo testes unitários/isolamento correspondentes, sem bloco monolítico.
- Termina obrigatoriamente com o bloco `## Verificação` (V.1 suíte completa, V.2 revisão de código/regras, V.3 `openspec validate --strict`, V.4 `ai-kit telemetry` + `entrega.md` + `handoff.md`).

### 6. Validação estrita do OpenSpec
- `openspec validate <change> --strict` passou sem erros.

## Severidade
- **Bloqueante:** falha no `openspec validate --strict`; `risk` ausente ou subestimado (`low` em área crítica); contraria ADR/princípio fixo sem justificativa; quebra isolamento multi-tenant/segurança; camada indefinida; UseCase chamando UseCase; regra de negócio na controller/view; duplica peça existente; `tasks.md` sem bloco `## Verificação`.
- **Importante:** contrato REST/erro incompleto; validação sem dono; tasks sem testes previstos; falta de rastreabilidade com `paths.application_map` ou `paths.technical_memory`.
- **Sugestão:** nomenclatura inconsistente; task que ganharia ao ser quebrada; detalhe que ficaria mais claro no design.

## Formato do Relatório

```markdown
## Bloqueante
- <arquivo:linha> | <problema> | <regra> | <ação sugerida>

## Importante
- ...

## Sugestão
- ...

## Validação OpenSpec
openspec validate --strict: <Passou | Falhou: erros>

## Resumo
N bloqueantes, N importantes, N sugestões. Risco validado: <low|medium|high>. Change revisada: <nome>.
```

Se não houver achados e o `validate` passar, diga em 1 linha que a proposta está sem pendências e pronta para aprovação humana (não invente problemas para preencher o relatório).
