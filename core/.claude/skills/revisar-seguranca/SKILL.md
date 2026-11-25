---
name: revisar-seguranca
description: Auditoria sob demanda de segurança em subagentes paralelos read-only (API/Auth, Dados/Multi-tenant, Arquivos/Logs/Segredos, Frontend, Dependências), com relatório agrupado em changes OpenSpec sugeridas.
managed-by: ai-kit
tier_ideal: T1_ARQUITETO
esforco_ideal: high
fallback_cota: T2_CONSTRUTOR
disable-model-invocation: true
argument-hint: "[pasta opcional para restringir o escopo]"
---

# Skill: revisar-seguranca

Auditoria independente de segurança sob demanda. **Estritamente read-only** sobre código, testes, configuração e `openspec/` — o único arquivo escrito é o relatório em `docs/seguranca/`.

## Escopo e Fontes
- Leia `.ai/project.yaml` (`stacks`, `paths`, `domain_rules`) e as regras de segurança/domínio em `paths.domain_rules_dir` (e `.claude/claude-security-guidance.md` ou `.claude/security-patterns.json`, se existirem).
- Sem argumento: repositório inteiro (ignorando `bin/`, `obj/`, `node_modules/`, `dist/`, `coverage/`, `.tmp/`, `.env*`). Com argumento: apenas a pasta informada e as frentes aplicáveis.

## Passos
1. Identifique as frentes aplicáveis às `stacks` do projeto e despache-as **em paralelo** em subagentes `general-purpose` **somente leitura** com contexto limpo.
2. **Método obrigatório dos subagentes:**
   - Entender mecanismos globais (política de fallback, middleware de tenant, RLS, filtros globais) **antes** de apontar falta local.
   - Seguir o fluxo ponta a ponta (fronteira → caso de uso → serviço → repositório → banco/integração).
   - Todo achado exige **caminho de ataque concreto** (ator, ação/requisição e impacto). Sem caminho plausível, rebaixe para Sugestão ou descarte.
   - Marque como `(a confirmar)` o que depende de infraestrutura/produção fora do repositório.
3. Consolide achados removendo duplicados, ordene por severidade (`Crítico` → `Alto` → `Médio` → `Sugestão`) e numere (`S-01`, `S-02`...).
4. Agrupe `Crítico` e `Alto` em **changes OpenSpec sugeridas por tema** (kebab-case curto); agrupe `Médio` e `Sugestão` numa change final de endurecimento.
5. Grave em `docs/seguranca/revisao-seguranca-AAAA-MM-DD.md` (acrescente `-2`, `-3` se já existir no dia).
6. Na conversa, responda só com: contagem por severidade, lista de críticos em 1 linha cada, nomes das changes sugeridas e caminho do relatório.

## Frentes (despachar apenas as que existem no projeto)
1. **API, Autenticação e Autorização:** rotas sem auth, permissões só no front, validação de JWT/cookie (`HttpOnly`/`Secure`/`SameSite`/CSRF), força bruta/enumeração em login/reset, CORS com credenciais, vazamento de erro interno, Swagger/debug em produção, mass assignment.
2. **Dados, Multi-tenant e Auditoria:** isolamento de tenant em toda tabela/query/worker/outbox, RLS/reset de conexão em pool, IDOR, `tenant_id` vindo do cliente, SQL dinâmico/concatenado, integridade de trilha de auditoria e regras de exclusão do domínio.
3. **Arquivos, Integrações, Logs e Segredos:** upload (validação de conteúdo, tamanho, path traversal, isolamento de chave por tenant), SSRF em conversores/webhooks, zip bomb/XXE/CSV formula injection, PII/LGPD em logs, segredos commitados (`git ls-files | grep -i env`).
4. **Frontend (se existir):** XSS (`dangerouslySetInnerHTML`, `innerHTML`, `javascript:`), tokens/segredos em storage ou `VITE_*`, open redirect, permissão/tenant confiados ao cliente, `target="_blank"` sem `rel="noopener noreferrer"`, PII em URL/console.
5. **Dependências (comandos read-only conforme stack):** `npm audit --omit=dev --json` / `pnpm audit --prod --json` / `dotnet list <sln> package --vulnerable --include-transitive`. Indique se o uso vulnerável é alcançável; se falhar por rede, registre em `Não verificado`.

## Formato de Achado e Relatório
```markdown
# Revisão de segurança: AAAA-MM-DD
Escopo: <projeto inteiro | pasta>
Resumo: N críticos, N altos, N médios, N sugestões

## Changes sugeridas
### 1. <nome-da-change> (Crítico)
Objetivo: <risco eliminado>
Achados: S-01, S-02
Áreas: <pastas/módulos>

## Mecanismos globais encontrados
- <proteções globais já existentes>

## Crítico / ## Alto / ## Médio / ## Sugestão
- **S-01** arquivo:linha | problema | caminho de ataque | como corrigir

## A confirmar em produção
## Não verificado
```
