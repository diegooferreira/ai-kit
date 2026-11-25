---
managed-by: ai-kit
paths:
  - "**/*{Test,Tests,Spec,test,spec,e2e}*.{cs,ts,tsx,js,jsx,mjs}"
  - "**/tests/**/*.{cs,ts,tsx,js,jsx,mjs}"
  - "**/__tests__/**/*.{ts,tsx,js,jsx,mjs}"
  - "**/e2e/**/*.{ts,js}"
  - "**/*.Tests/**/*.cs"
---

# Testes Automatizados

Todo código novo ou alterado nasce com teste automatizado.

- **Integridade inviolável:** é **estritamente proibido** silenciar (`.skip`, `only`, `[Fact(Skip=`), apagar ou enfraquecer assertions de testes existentes para forçar build verde. Se um teste quebrar por mudança legítima de regra, pause e escale como `BLOQUEADO`.
- **Cobertura mínima (piso, não meta):** **100%** em UseCases, Services e Validators; **80%** no restante (salvo limiar diferente definido pelo projeto). Teste que passa com comportamento quebrado não conta.
- **Princípios FIRST:** Rápido (mocks/stubs no unitário), Independente (passa em qualquer ordem), Repetível (relógio/aleatoriedade controlados, zero `Thread.Sleep`/`Task.Delay`/`waitForTimeout`), Autovalidável (verifica retorno e efeito).
- **Estrutura:** AAA separado por linha em branco; 1 conceito por teste; nome descrevendo comportamento e condição (ex.: `Should_RejectBooking_When_SlotIsTaken`).
- **Ordem de cobertura:** (1) regra mais crítica de negócio / isolamento multi-tenant, (2) caminho feliz, (3) bordas, entradas inválidas e falhas de colaborador.
- **Bugs e regressão:** correção de bug exige teste que reproduz a falha antes e passa depois. Teste intermitente deve ser investigado e corrigido, nunca silenciado.
