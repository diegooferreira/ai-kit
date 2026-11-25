---
managed-by: ai-kit
paths:
  - "**/*.sql"
  - "**/migrations/**"
  - "**/Migrations/**"
---

# Stack Pack: PostgreSQL

- Use `timestamptz` em UTC para datas/horas e `numeric` para valores monetários.
- Migrations versionadas, apenas para frente e nunca editadas após aplicadas em produção.
- Em sistemas multi-tenant: índices compostos iniciando por `(tenant_id, ...)`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY` (ou usuário da app sem ser owner) e definição de contexto via `SET LOCAL` dentro da transação para não vazar no pool de conexões.
- Toda query deve ser parametrizada (`@param` / `$1`); zero concatenação de filtros ou nomes dinâmicos de coluna.
