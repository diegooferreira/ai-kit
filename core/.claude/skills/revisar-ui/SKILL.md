---
name: revisar-ui
description: Revisa telas e componentes React/Tailwind contra as regras do stack pack react-tailwind.md (tokens, redação pt-BR, camadas, estados, responsividade e A11y).
managed-by: ai-kit
tier_ideal: T2_CONSTRUTOR
esforco_ideal: medium
fallback_cota: T3_OPERADOR
---

# Skill: revisar-ui

Fonte normativa: `.claude/rules/stacks/react/react-tailwind.md` (não duplique regras; audite os arquivos alterados contra ela).

## Passos
1. Identifique apenas componentes/páginas alterados (`git status --short`). Leia com `offset`/`limit` arquivos > 150 linhas.
2. Audite 5 eixos contra `react-tailwind.md`:
   - **Tokens e UI:** zero hex/px arbitrário, sem recriar primitivo shadcn, ícones padronizados.
   - **Redação pt-BR:** sentence case (zero `capitalize`), verbos no infinitivo, `Intl` para datas/moedas.
   - **Estados obrigatórios:** `loading` (skeleton), `empty`, `error` (`ErrorResponse`, zero `alert()`), botão desabilitado no submit.
   - **Camadas:** `*Page.tsx` sem `useState`/`useEffect`/query/chamada HTTP direta (extraído para `use<Tela>Page.ts`); sem ternário.
   - **Responsividade e A11y:** 360/768/1280px sem overflow, alvo ≥ 44px, `aria-label`, `label` em inputs, foco visível e contraste AA.
3. Corrija desvios mecânicos objetivos diretamente e rode o teste pontual do componente (se existir). Dúvidas visuais/UX vão para `## Para decidir`.

## Formato do Relatório

```markdown
## Correções aplicadas
- <arquivo:linha>: <ajuste realizado | nenhuma>

## Para decidir
- <dúvida visual/UX | nenhuma>

## Resumo
<N> correções aplicadas, <M> itens para decidir. Arquivos de UI revisados: <total>.
```

Se 100% conforme, responda em 1 linha: `Revisão de UI concluída sem pendências.`
