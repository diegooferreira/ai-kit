---
managed-by: ai-kit
paths:
  - "**/*.{cs,ts,tsx,js,jsx,mjs}"
---

# Estilo Narrativo

- **Orquestrador como sumário:** funções/métodos que coordenam várias etapas leem como um índice de negócio (chamadas nomeadas na ordem do fluxo), deixando detalhes em auxiliares privados/locais.
- **Auxiliares como etapas:** cada auxiliar representa 1 etapa compreensível sozinha e mantém o mesmo nível de abstração (limite de 20–30 linhas de `codigo.md`). Declare auxiliares na ordem de chamada (top-down).
- **Frontend:** aplica-se a fluxos imperativos (hooks, handlers, services), não à marcação JSX. Lógica que usa hooks vai para custom hook, não função auxiliar comum.
- **Código existente:** siga o estilo narrativo em código novo; ao corrigir função legada, preserve o estilo dela salvo pedido explícito de refatoração.
