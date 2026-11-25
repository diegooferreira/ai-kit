---
managed-by: ai-kit
paths:
  - "**/*.{cs,ts,tsx,js,jsx,mjs}"
---

# Tratamento de Exceções e Erros

Falha inesperada propaga como exceção; resultado esperado (validação, não encontrado, conflito) segue o contrato do projeto.

- **Catch só onde age:** capture para recuperar/retentar, traduzir para o domínio, adicionar contexto ou converter na fronteira. **Proibido catch vazio** ou catch que só loga e engole.
- **Catch específico:** em C#, capture só o tipo tratado (`catch (Exception)` apenas na fronteira). Em JS/TS, verifique se o erro é o esperado e relance os demais.
- **Preservar stack trace:** em C#, use `throw;`, **nunca `throw ex;`**. Ao envolver exceção, mantenha a original como `innerException` (`cause` em JS/TS).
- **Contrato `Try...`:** informa resultado no retorno e trata apenas a falha declarada; o restante propaga intacto.
- **Fronteira centralizada:** middleware HTTP / wrapper de consumer / runner de job loga exceção não tratada uma única vez e devolve resposta padrão com correlation ID (sem vazar stack trace ou SQL).
- **Formato padrão (projetos novos):** `Error { Code, Message }` dentro de `ErrorResponse { Errors: Error[] }`, com códigos e mensagens em constantes centralizadas e status HTTP adequado (400/404/409). Em projeto existente, siga o formato já adotado.
