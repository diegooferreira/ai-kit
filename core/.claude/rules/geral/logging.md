---
managed-by: ai-kit
paths:
  - "**/*.{cs,ts,tsx,js,jsx,mjs}"
---

# Logging e Observabilidade

Use o logger/telemetria adotado pelo projeto.

- **Logue nas fronteiras:** entrada de requisição/evento, decisão-chave, chamada externa (ida e volta) e conclusão. Funções internas triviais ficam fora.
- **Log estruturado:** sempre use propriedades nomeadas (`_logger.LogInformation("Batch {BatchId} synced for {TenantId}", id, tenantId)`), nunca interpolação de string nem `Console.WriteLine` em código de aplicação.
- **Correlation ID:** introduza na fronteira (`Activity`/OpenTelemetry, middleware, header ou `BeginScope`) e propague nas chamadas externas.
- **Níveis:** `Debug` (diagnóstico), `Information` (marco do fluxo), `Warning` (anomalia recuperada/retry), `Error` (falha que exige atenção).
- **Logue a falha uma única vez:** a fronteira registra exceção não tratada com stack trace, correlation ID e ID da entidade; camadas intermediárias não duplicam log.
- **ID, nunca payload/PII:** nunca logue senhas, tokens, segredos, CPF, e-mail ou payload completo.
