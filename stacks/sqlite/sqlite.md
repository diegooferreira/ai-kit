---
managed-by: ai-kit
paths:
  - "**/*.sql"
  - "**/db/**"
  - "**/database/**"
---

# Stack Pack: SQLite

- Habilite `PRAGMA journal_mode = WAL;`, `PRAGMA foreign_keys = ON;` e `PRAGMA busy_timeout = 5000;` ao abrir a conexão.
- Agrupe escritas em lote dentro de transações explícitas (`BEGIN IMMEDIATE ... COMMIT`) para evitar lock contention.
- Padronize datas em ISO-8601 UTC (`TEXT`) ou epoch inteiro (`INTEGER`) de forma consistente.
- Em testes que validam WAL, durabilidade ou rotação de arquivo, use arquivo temporário por teste (nunca `:memory:`) e apague ao final.
