---
managed-by: ai-kit
paths:
  - "**/*.{cs,ts,tsx,js,jsx,mjs}"
---

# Performance

Correto e simples primeiro; otimize apenas com medição — exceto bugs claros corrigidos sempre: **vazamento de recurso, N+1 e consulta sem limite**.

- **Banco de dados:**
  - Zero N+1: busque em lote ou join, nunca query dentro de loop.
  - Consulta limitada: toda listagem pagina e projeta apenas colunas usadas.
  - Transação curta: nunca mantenha conexão/transação aberta aguardando HTTP, fila ou serviço externo.
- **Recursos:** libere sempre (`using`/`await using` em C#); use `IHttpClientFactory` (nunca `new HttpClient()` por chamada); no front, limpe timers/listeners/subscriptions e cancele requisições obsoletas.
- **Async ponta a ponta:** `await` da fronteira até I/O, propagando `CancellationToken`. Sem `.Wait()`, `.GetAwaiter().GetResult()` ou `.Result` bloqueante. Não torne assíncrono o que é cálculo puro síncrono.
