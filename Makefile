# Makefile — comandos do dia a dia
# Uso: make <alvo>
# Ex:  make infra-up    → sobe postgres, redis, kafka, elasticsearch
#      make dev         → sobe infra + inicia todos os serviços em modo watch

.PHONY: dev build test lint type-check \
        infra-up infra-down infra-logs \
        db-migrate db-seed db-studio \
        clean help

# ─── Desenvolvimento ──────────────────────────────────────────────────────────

# Sobe a infraestrutura e inicia todos os serviços em modo watch (hot reload)
dev: infra-up
	pnpm run dev

# Somente infraestrutura (postgres, redis, kafka, elasticsearch)
# Os serviços NestJS/Next.js rodam diretamente com pnpm (hot reload nativo)
infra-up:
	docker compose up postgres redis kafka kafka-ui elasticsearch -d
	@echo "⏳ Aguardando serviços ficarem saudáveis..."
	@docker compose ps

infra-down:
	docker compose down

infra-logs:
	docker compose logs -f postgres redis kafka elasticsearch

# ─── Banco de dados ───────────────────────────────────────────────────────────

# Roda migrations em todos os serviços (ordem importa: auth antes de booking)
db-migrate:
	pnpm --filter @showpass/auth-service    run db:migrate
	pnpm --filter @showpass/event-service   run db:migrate
	pnpm --filter @showpass/booking-service run db:migrate
	pnpm --filter @showpass/payment-service run db:migrate

# Seed inicial (planos, categorias, usuário admin)
db-seed:
	pnpm --filter @showpass/event-service run db:seed

# Abre o Prisma Studio para um serviço específico
# Uso: make db-studio SERVICE=event-service
db-studio:
	pnpm --filter @showpass/$(SERVICE) run db:studio

# ─── Qualidade de código ──────────────────────────────────────────────────────

lint:
	pnpm run lint

type-check:
	pnpm run type-check

test:
	pnpm run test

test-e2e:
	pnpm run test:e2e

# Simular pipeline CI localmente (mesmo que roda no GitHub Actions)
ci: lint type-check test
	@echo "✅ CI passou localmente"

# ─── Build & Deploy ───────────────────────────────────────────────────────────

build:
	pnpm run build

# Remove builds, node_modules e volumes Docker locais
clean:
	pnpm run clean
	docker compose down -v  # remove volumes de dados locais (cuidado: apaga dados!)

# ─── Setup inicial ────────────────────────────────────────────────────────────

# Setup completo do ambiente do zero
setup: infra-up
	@echo "⏳ Aguardando banco ficar pronto..."
	@sleep 5
	pnpm install
	$(MAKE) db-migrate
	$(MAKE) db-seed
	@echo "✅ Setup completo!"
	@echo "   Frontend:    http://localhost:3000"
	@echo "   API Gateway: http://localhost:3001"
	@echo "   Swagger UI:  http://localhost:3001/docs"
	@echo "   Kafka UI:    http://localhost:8080"

# ─── Ajuda ───────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "ShowPass — Comandos disponíveis"
	@echo "================================"
	@echo ""
	@echo "Desenvolvimento:"
	@echo "  make setup        Setup completo do ambiente (primeira vez)"
	@echo "  make dev          Sobe infra + serviços em modo watch"
	@echo "  make infra-up     Sobe apenas postgres, redis, kafka, elasticsearch"
	@echo "  make infra-down   Para todos os containers"
	@echo "  make infra-logs   Tail de logs da infra"
	@echo ""
	@echo "Banco de dados:"
	@echo "  make db-migrate   Roda migrations em todos os serviços"
	@echo "  make db-seed      Popula dados iniciais"
	@echo "  make db-studio    Abre Prisma Studio (SERVICE=event-service)"
	@echo ""
	@echo "Qualidade:"
	@echo "  make lint         ESLint em todos os pacotes"
	@echo "  make type-check   TypeScript check em todos os pacotes"
	@echo "  make test         Testes unitários"
	@echo "  make test-e2e     Testes E2E (Playwright)"
	@echo "  make ci           Simula pipeline CI localmente"
	@echo ""
	@echo "Build:"
	@echo "  make build        Build de produção de todos os serviços"
	@echo "  make clean        Remove builds e volumes locais"
	@echo ""
