---
managed-by: ai-kit
paths:
  - "**/e2e/**"
  - "**/*.spec.ts"
  - "**/*.e2e.ts"
  - "**/playwright.config.*"
---

# Stack Pack: Playwright / Testes E2E

- Priorize seletores semânticos (`getByRole`, `getByLabel`, `getByTestId`) em vez de seletores CSS frágeis.
- Nunca use `waitForTimeout` fixo; aguarde visibilidade, respostas de rede ou assertions com auto-retry (`expect(locator).toBeVisible()`).
- Isole massa de dados por teste para permitir repetição independente de ordem e execução paralela (compatível com Onda 1 / `IA-UI` do `homologar-change`).
- Execute em modo compacto (`--reporter=line`) durante ciclos com IA.
