---
managed-by: ai-kit
paths:
  - "**/*.sql"
  - "**/migrations/**"
  - "**/models/**"
---

# Stack Pack: MariaDB / MySQL

- Utilize charset `utf8mb4`, collation `utf8mb4_unicode_ci` e engine `InnoDB` para integridade transacional e FKs.
- Armazene valores monetários em `DECIMAL(12,2)` (nunca `FLOAT`/`DOUBLE`) e datas em UTC (`DATETIME`/`TIMESTAMP`).
- Toda query usa placeholders parametrizados (`?` / `:param`); crie índices explícitos em colunas de tenant, busca, ordenação e FK.
- Migrations devem ser incrementais e acompanhadas de estratégia clara de rollback.
