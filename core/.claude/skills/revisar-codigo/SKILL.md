---
name: revisar-codigo
description: Revisa código recém-escrito contra design.md, memória técnica e rules de arquitetura, código, design, narrativa, exceções e testes. Corrige desvios mecânicos objetivos e relata dúvidas de design em Para decidir.
managed-by: ai-kit
tier_ideal: T2_CONSTRUTOR
esforco_ideal: medium
fallback_cota: T3_OPERADOR
---

# Skill: revisar-codigo

> **Escalonamento:** se o diff tocar autenticação, autorização, isolamento multi-tenant/RLS ou cálculos financeiros, recomende subir para `T1_ARQUITETO`.

## Passos
1. Liste os arquivos alterados (`git status --short` / `git diff --name-only HEAD`) e leia `.ai/project.yaml`, `openspec/changes/<change>/design.md` (se houver change ativa) e `paths.technical_memory`.
2. Não releia manualmente rules já carregadas pelo ambiente; leia trechos de arquivos grandes (> 100 linhas) com `offset`/`limit`.
3. Aplique o checklist abaixo:
   - **Desvios mecânicos objetivos de regra** (método > 30 linhas extraível, `throw ex;`, DI/composição faltando, ternário, import morto, constante mágica): **corrija diretamente** nos arquivos da change e valide com teste unitário pontual.
   - **Dúvidas de design, contrato ou regra de negócio:** **não altere comportamento** — registre em `## Para decidir`.

## Checklist
1. **Arquitetura da stack e domínio:** camadas respeitadas conforme `.claude/rules/stacks/` e `.claude/rules/dominio/`; sem UseCase chamando UseCase; sem regra de negócio em controller/rota/view; validação na borda; DI/composição registrada; isolamento de tenant preservado.
2. **Duplicação e design:** regra da 3ª ocorrência; colaboradores substituíveis; relógio injetado (`TimeProvider` / `IClock` / `Clock`); responsabilidade coesa.
3. **Tamanho e narrativa:** método ≤ 30 linhas executáveis; arquivo > 100 linhas coeso; orquestrador narrativo; ≤ 4 parâmetros.
4. **Exceções, logging e performance:** `throw;`, sem catch vazio, sem dado sensível em log, sem N+1, consulta limitada/paginada, async ponta a ponta + `CancellationToken`.
5. **Integridade de testes e ferramentas:** zero `.skip`/`only`, zero `@ts-ignore`/`eslint-disable`/`#pragma warning disable`, zero `as unknown as`; UseCases/Services/Validators novos cobertos (piso 100%), caminho feliz + bordas/erros, nomenclatura comportamental.

## Formato do Relatório

```markdown
## Correções aplicadas
- <arquivo:linha>: <desvio corrigido e resultado do teste pontual | nenhuma>

## Para decidir (dúvidas de design ou trade-offs)
- <arquivo:linha>: <dúvida conceitual ou bloqueante de design | nenhuma>

## Resumo
<N> correções aplicadas, <M> itens para decidir. Arquivos revisados: <total>.
```

Se 100% conforme, responda em 1 linha: `Revisão de código concluída sem pendências.`
