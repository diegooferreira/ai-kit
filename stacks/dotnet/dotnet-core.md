---
managed-by: ai-kit
paths:
  - "**/*.cs"
  - "**/*.csproj"
  - "**/*.sln"
  - "**/*.slnx"
---

# Stack Pack: .NET / C#

Padrão para projetos novos (.NET 8+ ou .NET Framework 4.8). Em projeto existente, respeite a organização atual e aponte conflitos.

## Arquitetura em Camadas
Dependências apontam para `Borders`: `Api → UseCases / Services / Repositories → Borders`.
- **`Borders`:** portas (`I*UseCase`, `I*Repository`, `I*Service`), DTOs (`*Request`, `*Response`, `*Dto` interno), `Validators/` (FluentValidation), `Error`/`ErrorResponse` e `Constants/` (códigos/mensagens de erro, status). Não depende de nenhuma outra camada.
- **`UseCases`:** 1 caso de uso por classe. **Um UseCase nunca chama outro UseCase** (lógica compartilhada vai para `Services`).
- **`Services`:** regra/orquestração compartilhada entre UseCases.
- **`Repositories`:** banco e clientes HTTP externos (`Clients/`).
- **`Api`:** controllers finas, middlewares e composition root (DI). Zero regra de negócio.

## Validação e DI
- Validação de `Request` apenas em `Borders/Validators/` com `AbstractValidator<TRequest>` injetado via `IValidator<TRequest>` no UseCase (sem `if` manual espalhado).
- Registre cada camada via extension method (`AddUseCases`, `AddServices`, `AddRepositories`, `AddValidators`) na mesma mudança. Lifetime padrão: `Scoped` (`Singleton` só stateless comprovado; `HttpClient` via `IHttpClientFactory`). Nunca use `IServiceProvider` como service locator.

## Dados e Relógio (Flexível por Versão do .NET)
- SQL explícito e parametrizado (Dapper ou ferramenta adotada); zero interpolação/concatenação em SQL. Propague `CancellationToken` em todo I/O assíncrono.
- **Relógio injetado (zero `DateTime.Now`/`DateTime.UtcNow` direto em regra de negócio):**
  - Em **.NET 8+**, injete o `TimeProvider` nativo (`TimeProvider.System` no DI; `FakeTimeProvider` nos testes).
  - Em **.NET Framework 4.8** (ou projetos sem `TimeProvider`), injete uma porta `IClock` / `IDateTimeProvider` (ex.: `DateTime UtcNow { get; }`) registrada no DI e mockada nos testes.

## Testes e Cobertura
- Rode testes com `--nologo --verbosity minimal`.
- Em execuções filtradas (`dotnet test --filter ...`), passe `/p:CollectCoverage=false` para evitar falha espúria do piso do Coverlet; o piso completo roda na suíte inteira via `rodar-testes`.
- Marque testes com Docker/Testcontainers com `[Trait("Category", "Integration")]`.
