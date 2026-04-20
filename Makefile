# Makefile — comandos do dia a dia
# Uso: make <alvo>
# Ex:  make infra-up    → sobe postgres, redis, kafka, elasticsearch
#      make dev         → sobe infra + inicia todos os serviços em modo watch

.PHONY: dev build test lint type-check \
        infra-up infra-down infra-logs \
        db-generate db-migrate db-seed db-studio \
        copy-env gen-keys \
        github-setup clean help

# ─── Desenvolvimento ──────────────────────────────────────────────────────────

# Sobe a infraestrutura e inicia todos os serviços em modo watch (hot reload)
dev: infra-up
	pnpm run dev

# Inicia apenas os serviços implementados no capítulo atual (sem web/worker/etc)
dev-services:
	@bash scripts/dev.sh start

dev-stop:
	@bash scripts/dev.sh stop

dev-status:
	@bash scripts/dev.sh status

dev-logs:
	@bash scripts/dev.sh logs

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

# Gera os Prisma Clients (tipagem). Necessário ANTES de type-check/build em máquinas
# novas — o booking-service usa custom output path (src/prisma/generated).
db-generate:
	pnpm --filter @showpass/auth-service    run db:generate
	pnpm --filter @showpass/event-service   run db:generate
	pnpm --filter @showpass/booking-service run db:generate
	pnpm --filter @showpass/payment-service run db:generate

# Roda migrations em todos os serviços já implementados.
# A ordem importa: auth antes dos demais (não há FK cross-DB, mas ajuda no debug).
db-migrate: db-generate
	pnpm --filter @showpass/auth-service    run db:migrate
	pnpm --filter @showpass/event-service   run db:migrate
	pnpm --filter @showpass/booking-service run db:migrate
	pnpm --filter @showpass/payment-service run db:migrate

# Seed inicial (planos, categorias, usuário admin)
db-seed:
	pnpm --filter @showpass/auth-service    run db:seed
	pnpm --filter @showpass/event-service   run db:seed
	pnpm --filter @showpass/payment-service run db:seed

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

# ─── GitHub — Branch Protection ──────────────────────────────────────────────

# Configura branch protection na main via GitHub CLI.
# Deve ser rodado UMA VEZ após criar o repositório no GitHub.
# Pré-requisito: gh auth login
# Uso: make github-setup GITHUB_REPO=seu-usuario/showpass
github-setup:
	@if [ -z "$(GITHUB_REPO)" ]; then \
		echo "Erro: defina GITHUB_REPO. Ex: make github-setup GITHUB_REPO=seu-usuario/showpass"; \
		exit 1; \
	fi
	GITHUB_REPO=$(GITHUB_REPO) sh .github/branch-protection.sh

# ─── Setup inicial ────────────────────────────────────────────────────────────

# Copia .env.example → .env para cada serviço (não sobrescreve se já existir)
copy-env:
	@for dir in apps/*/; do \
		if [ -f "$$dir.env.example" ] && [ ! -f "$$dir.env" ]; then \
			cp "$$dir.env.example" "$$dir.env"; \
			echo "  ✓ $$dir.env criado (preencha os valores antes de rodar)"; \
		fi; \
	done
	@echo "ℹ️  Edite os arquivos .env antes de continuar (especialmente RSA keys e secrets)"

# Gera par de chaves RSA 4096-bit e distribui a chave pública para os outros serviços
# Pré-requisito: ter copiado .env.example → .env em todos os serviços
gen-keys:
	@echo "🔑 Gerando par de chaves RSA 4096-bit para o auth-service..."
	@openssl genrsa -out /tmp/showpass_private.pem 4096 2>/dev/null
	@openssl rsa -in /tmp/showpass_private.pem -pubout -out /tmp/showpass_public.pem 2>/dev/null
	@python3 scripts/gen-keys.py
	@rm -f /tmp/showpass_private.pem /tmp/showpass_public.pem
	@echo "✅ Chaves RSA geradas e distribuídas para todos os serviços"

# Setup completo do ambiente do zero
setup: copy-env infra-up
	@echo "⏳ Aguardando banco ficar pronto..."
	@sleep 5
	pnpm install
	$(MAKE) db-migrate
	$(MAKE) db-seed
	@echo "✅ Setup completo!"
	@echo "   Frontend:    http://localhost:3000"
	@echo "   API Gateway: http://localhost:3000"
	@echo "   Swagger UI:  http://localhost:3000/docs"
	@echo "   Kafka UI:    http://localhost:8080"
	@echo ""
	@echo "⚠️  Se é a primeira vez: rode 'make gen-keys' para gerar as chaves RSA"

# ─── Ajuda ───────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "ShowPass — Comandos disponíveis"
	@echo "================================"
	@echo ""
	@echo "Desenvolvimento:"
	@echo "  make copy-env     Copia .env.example → .env (não sobrescreve)"
	@echo "  make gen-keys     Gera chaves RSA e distribui public key"
	@echo "  make setup        Setup completo do ambiente (primeira vez)"
	@echo "  make dev          Sobe infra + serviços em modo watch"
	@echo "  make infra-up     Sobe apenas postgres, redis, kafka, elasticsearch"
	@echo "  make infra-down   Para todos os containers"
	@echo "  make infra-logs   Tail de logs da infra"
	@echo ""
	@echo "Banco de dados:"
	@echo "  make db-generate  Gera os Prisma Clients (antes de type-check/build)"
	@echo "  make db-migrate   Roda migrations + garante db-generate"
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
	@echo "GitHub (rodar uma vez após criar o repositório):"
	@echo "  make github-setup GITHUB_REPO=owner/repo"
	@echo "                    Configura branch protection na main"
	@echo ""
