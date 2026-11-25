---
managed-by: ai-kit
paths:
  - "**/*.{cs,ts,tsx,js,jsx,mjs}"
---

# Padrões de Design

- **Uma responsabilidade por unidade:** separe responsabilidades independentes na unidade natural da linguagem (classe, módulo, função ou componente). Coordenar etapas do mesmo caso de uso não exige fragmentação artificial.
- **Colaborador substituível:** em C#, colaborador de serviço injetado entra por interface (mesmo com 1 implementação) para isolamento em teste unitário. Em JS/TS, use função/objeto por parâmetro ou módulo (sem contêiner artificial). Dados/DTOs não são colaboradores.
- **Abstração na terceira ocorrência:** generalize ou extraia código compartilhado apenas na 3ª ocorrência essencial (mesmo conceito que muda junto). Repetição acidental permanece concreta.
  - Escolha o formato certo: classe base (mesma infraestrutura), Service injetado (regra compartilhada entre UseCases), função pura/extension (transformação sem estado), custom hook/componente (UI repetida).
- **Funções puras e relógio injetado:** explicite entradas/saídas e nunca leia relógio global ou aleatoriedade dentro de regra de negócio; receba `now` ou injete `TimeProvider` / `IClock` / `Clock`.
- **Difícil de testar é sinal de design:** corrija o acoplamento em vez de complicar o teste.
