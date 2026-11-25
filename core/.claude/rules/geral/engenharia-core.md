---
managed-by: ai-kit
---

# Papel do Executor e Engenharia Core (AI-Kit v2.1)

Responda em português do Brasil. Identificadores de código seguem o vocabulário do projeto; em projeto existente, convenções do repositório prevalecem (aponte conflitos em vez de impor).

## Regras Fundamentais
1. **Fonte única:** consulte `.ai/project.yaml` para comandos, suítes, caminhos e stacks; nunca invente scripts.
2. **Preflight Global de Modelo (`.ai/modelos.md`):** antes de executar qualquer skill, valide `tier_ideal` e `fallback_cota` no frontmatter dela. Se estiver abaixo de `tier_ideal`, PAUSE e pergunte antes de ler arquivos do projeto; se `fallback_cota: none`, nunca rebaixe.
3. **Fronteiras (`ai.mode == multi-ia`):**
   - Implemente changes aprovadas via `/aplicar-change` (1 bloco por vez, subagente limpo).
   - Não altere `proposal.md`, `design.md` ou `specs/`; se o design se mostrar errado, pare, registre em `entrega.md` e solicite ajuste via `openspec-update-change`.
   - Não arquive, não faça commit nem push (responsabilidade do `concluir-change`).
4. **Mudanças mínimas e integridade de testes:** altere apenas o necessário para o bloco atual; sem refatorações oportunistas, sem pacote novo sem autorização e **nunca** enfraqueça/pule testes ou silencie linters para forçar build verde.
5. **Execução silenciosa e econômica:** chame ferramentas diretamente sem narrar passos; localize com `grep`/LSP e leia trechos com `offset`/`limit` (evite ler arquivos > 300 linhas ou logs inteiros).

## Hooks e Telemetria
- `proteger-arquivos.cjs` (`PreToolUse`): bloqueia `.env`, arquivos `managed-by: ai-kit` e remoção/ausência de `paths:` em `.claude/rules/dominio/` (`Write`/`Edit`/`MultiEdit`).
- `verificar-regras.cjs` (`PostToolUse`): confere regras mecânicas e travas anti-vibe-coding (ternário, `any`, `as unknown as`, `throw ex;`, `catch {}`, bloqueio async, `DateTime.Now` direto, cor/px fixo, `capitalize`, lógica em view, `.skip`/supressões, espera fixa em teste e queda de assertions).
- `filtrar-saida-testes.cjs` (`PreToolUse` Bash): compacta logs de build/testes preservando exit code sem auto-aprovar comandos compostos. **Nunca adicione `2>&1`, `| tail` ou `| head`** em comandos de build/teste.
- `ai-kit telemetry --target .`: gera `Diff_Hash`, `Sensitive_touched`, `Test_integrity` e `Suites_hint` deterministicamente.

## Formato Padrão de `openspec/changes/<change>/entrega.md`
```markdown
# Entrega: <change>

Status: pronta para arquivar | bloqueada: <motivo>
Diff_Hash: <hash retornado por ai-kit telemetry>
Telemetria: <Test_integrity OK/ALERTA | Sensitive_touched: nenhum ou lista>

## O que foi feito
- <1 linha por bloco>

## Testes
- <saída literal do último rodar-testes + SEM SUÍTE aceitos>

## Revisões
- revisar-codigo: <sem pendências | resumo>
- <outras skills em reviewers>: <sem pendências | não se aplica | resumo>

## Divergências do design
- <nenhuma | o que divergiu e por quê>

## Mapa
- <módulos, rotas, tabelas, eventos ou comandos novos para APPLICATION_MAP.md>

## Armadilhas e aprendizados técnicos
- <nenhum | [Área] Problema não óbvio enfrentado -> Solução aplicada>
```

## Compactação de Contexto
Ao compactar, preserve: arquivos alterados e por quê, decisões tomadas, testes que falharam e causa raiz, e perguntas em aberto. Descarte saídas brutas já resolvidas.
