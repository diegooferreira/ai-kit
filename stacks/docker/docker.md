---
managed-by: ai-kit
paths:
  - "**/Dockerfile*"
  - "**/docker-compose*.yml"
  - "**/docker-compose*.yaml"
  - "**/compose*.yml"
  - "**/compose*.yaml"
  - "**/.dockerignore"
---

# Stack Pack: Docker & Compose

- Use multi-stage builds com imagens base leves e tags de versão fixas (evite `:latest` em produção).
- Nunca grave segredos ou arquivos `.env` dentro da imagem; injete via variáveis de ambiente em runtime.
- Defina `healthcheck` para serviços críticos (banco, fila, API) e use `depends_on` com `condition: service_healthy`.
- Lembre-se da diferença entre `docker compose exec` (roda comando direto) e `docker compose run` (anexa argumentos ao `ENTRYPOINT` da imagem) ao escrever comandos de ambiente ou roteiros de QA.
