---
managed-by: ai-kit
paths:
  - "**/*.{ts,js,cjs,mjs}"
  - "package.json"
---

# Stack Pack: Node.js + TypeScript

## Arquitetura Modular
Dependências apontam para `contracts`: `http → use-cases / services / repositories → contracts`.
- **`contracts/`:** schemas Zod de request/response, tipos, portas de colaboradores e `<modulo>Errors.{codes,messages}`.
- **`use-cases/`:** 1 caso de uso por arquivo (fábrica recebendo `deps`, sem contêiner de DI pesado). **Um caso de uso nunca chama outro** (lógica compartilhada vai para `services/`).
- **`services/`:** regras compartilhadas e funções puras (recebem `now` por parâmetro).
- **`repositories/`:** único lugar com SQL/ORM e chamadas `fetch` externas; funções multi-tenant recebem contexto do tenant explicitamente.
- **`http/`:** rotas finas que validam via Zod, chamam o caso de uso e devolvem resposta (`ErrorResponse` em erro).
- **`composition/`:** liga dependências e registra rotas na mesma mudança.

## Regras Essenciais
- Zero `any` em TypeScript; valide payloads externos com Zod nas bordas.
- Trate rejeições assíncronas com middleware central de erro; nunca exponha stack trace em produção.
- **Relógio e IDs injetados:** `Date.now()`, `new Date()` e geradores de ID vivem em `Clock`/adaptador em `shared/`, nunca soltos em regra de negócio.
- Queries sempre parametrizadas; migrations SQL numeradas e apenas para frente (nunca editar migration aplicada); transações abertas no caso de uso quando a operação é atômica.
- Respeite ESM vs CommonJS do projeto; hooks do AI-Kit são sempre `.cjs`.
