# ShowPass — Instruções para Claude Code

## Por que este projeto existe (PORQUÊ)

Tutorial em pt-BR de um clone do Ticketmaster em nível de big tech.
O problema central: 300.000 pessoas tentam comprar o mesmo assento ao mesmo tempo.
A solução: Redis SETNX atômico — operação que torna double booking impossível.

Audiência: engenheiros seniores pt-BR. Código sempre com comentários explicando o PORQUÊ.

---

## Mapa do repositório (O QUÊ)

```
apps/             NestJS microservices (api-gateway, auth, event, booking, payment, search, worker)
packages/         Shared libs (types/Zod, kafka, redis)
infra/            K8s manifests, Terraform, Docker configs
docs/             18-chapter tutorial + ADRs + runbooks + architecture
.github/          CI/CD workflows (ci.yml cresce a cada capítulo)
CLAUDE.md         ← este arquivo
```

Cada `apps/<service>/` tem seu próprio `CLAUDE.md` com os "gotchas" daquele serviço.

---

## Regras de funcionamento (COMO)

### Stack (versões fixas — não sugerir downgrades)
- Node.js 22 LTS · NestJS 11 · Prisma 7 · Next.js 16.2
- TypeScript 6.0 · Zod 4 · Stripe SDK 22
- PostgreSQL 18 · Redis 8.6 · Elasticsearch 9.3 · Kafka 4.2
- Docker Engine 29.1 · Kubernetes EKS 1.35 · Terraform 1.14.8

### Padrões obrigatórios
- **Idioma:** todo código, comentários e prosa dos capítulos em **pt-BR**
- **Comentários:** explicar o PORQUÊ, nunca o O QUÊ (o código já diz o quê)
- **Zod 4:** usar `z.uuid()`, `z.url()`, `z.email()` (top-level, não `z.string().uuid()`)
- **Repository pattern:** controllers nunca importam PrismaService diretamente
- **Tenant isolation:** toda query passa `organizerId` — nunca consultar sem filtro
- **OWASP:** anotar inline qual mitigação cada bloco implementa (A01–A10)
- **Imports:** usar path aliases `@showpass/types`, `@showpass/kafka`, etc.

### Guardrails — NUNCA fazer sem confirmação
- Alterar arquivos em `prisma/migrations/` (histórico imutável)
- Alterar `apps/auth-service/src/` sem ler `apps/auth-service/CLAUDE.md`
- Alterar lógica de locks em `apps/booking-service/src/modules/locks/`
- Fazer `git push --force` ou `kubectl delete` em qualquer contexto
- Remover ou alterar `packages/redis/src/redis.service.ts` (Lua scripts críticos)

### Decisões arquiteturais — ver `docs/decisions/`
As ADRs explicam PORQUÊ escolhemos cada tecnologia.
Antes de sugerir trocar Redis por banco, Kafka por HTTP síncrono, etc. — leia o ADR correspondente.

### Para adicionar um novo serviço NestJS
Ver `.claude/skills/new-service.md`

### Para criar uma migration Prisma
Ver `.claude/skills/prisma-migration.md`

### Para revisar código gerado
Ver `.claude/skills/code-review.md`
