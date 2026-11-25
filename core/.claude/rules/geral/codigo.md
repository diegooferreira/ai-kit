---
managed-by: ai-kit
paths:
  - "**/*.{cs,ts,tsx,js,jsx,mjs}"
---

# Padrões de Codificação

Use a solução mais simples que resolve o pedido.

- **Nomes como especificação:** expresse contrato/efeito (`IsEnrollmentOpen`, `RemoveIfExists`, `TrySyncBatch`). Comente só o que o nome não carrega (regex complexa, restrição externa, motivo não óbvio).
- **Tamanho:** arquivo > 100 linhas é ponto de revisão (separe responsabilidades distintas); método imperativo tem 20 linhas como revisão e **30 linhas como teto** (extraia etapas nomeadas). JSX, templates e configuração não contam.
- **Decisões explícitas:** **sem ternário** (use `if`, guarda com retorno antecipado ou `condition && <El />` no JSX). Até 3 níveis de `if/else`. Em C#, `=>` apenas em métodos simples de 1 linha.
- **Parâmetros e variáveis:** até 4 parâmetros por função/método (acima disso, agrupe em objeto parâmetro). Declare variáveis perto do primeiro uso; no máximo 1 linha em branco entre blocos.
- **Valores mágicos e segredos:** status, códigos e mensagens de erro vivem em constantes nomeadas (ex.: `AuthErrors.Codes` / `AuthErrors.Messages`). Segredos e connection strings entram apenas por configuração/ambiente.
- **Escopo:** remova imports/variáveis que sua própria mudança deixou sem uso; mencione código morto preexistente sem refatorar fora do escopo.
