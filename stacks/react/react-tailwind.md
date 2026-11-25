---
managed-by: ai-kit
paths:
  - "**/*.{tsx,jsx}"
  - "**/src/{features,shared,components,hooks,services,pages,lib,types}/**/*.{ts,js}"
  - "**/src/**/*.{css,scss}"
  - "**/tests/**/*.{ts,tsx}"
---

# Stack Pack: React + TypeScript + Tailwind CSS

## Camadas e Telas
- Fluxo unidirecional: `UI (componentes) → hooks → services (HTTP/API) → types (tipos e schemas Zod)`. Componente nunca importa `services` diretamente nem faz `fetch`/`axios` solto em `useEffect`.
- **View separada da controller:** toda tela (`*Page.tsx`) delega estado, queries, mutations e handlers para um hook dedicado (`use<Tela>Page.ts`). A view apenas consome o hook e renderiza (zero `useState`/`useEffect`/`useMemo`/`useCallback` na view).
- **Regra de negócio fica no backend:** o front faz validação de UX, formatação e exibição; cálculos críticos, permissões e elegibilidade pertencem à API.
- **TypeScript & Ambiente:** zero `any` (use `unknown` + estreitamento ou Zod). Variáveis de ambiente apenas com prefixo `VITE_`; nenhum segredo vai ao bundle.

## UI, Tokens e Redação (pt-BR)
- Tailwind CSS + shadcn/ui + `lucide-react` (salvo padrão diferente do projeto). Nunca recrie primitivo já oferecido pelo shadcn.
- **Tokens:** proibido hex/px fixo (`bg-[#...]`, `p-[13px]`, `style={{ color: '#...' }}`); use tokens semânticos e escala Tailwind (múltiplos de 4px).
- **Redação:** sentence case em toda a UI (proibido `capitalize`); botões com verbo no infinitivo sem ponto final; datas (`dd/MM/yyyy`) e moeda via `Intl`.
- **Estados obrigatórios:** `loading` (skeleton), `empty` (mensagem contextual), `error` (normalizado de `ErrorResponse`, zero `alert()`), botão desabilitado durante submit.
- **Responsividade e A11y:** sem overflow horizontal (360/768/1280px), alvo de toque ≥ 44px, `aria-label` em botão de ícone, `label` associado a input, foco visível e contraste AA.

## Testes
- Vitest + Testing Library: queries acessíveis (`getByRole`, `getByLabelText`, `getByText`); `getByTestId` só em último caso.
- Teste lógica de hooks com `renderHook`; mock na camada de service/hook ou MSW.
