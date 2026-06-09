# Makefile — comandos do dia a dia
# Uso: make <alvo>
# Ex:  make infra-up    → sobe postgres, redis, kafka, elasticsearch
#      make dev         → sobe infra + inicia todos os serviços em modo watch

.PHONY: dev dev-services dev-stop dev-status dev-logs \
        build test lint type-check audit ci \
        up down compose-build ascii-link \
        infra-up infra-down infra-logs kafka-topics \
        obs-up obs-down obs-logs \
        db-generate db-migrate db-seed db-studio \
        copy-env gen-keys \
        github-setup clean help

# ─── Docker Compose — workaround do "ç" no caminho ────────────────────────────
# PORQUÊ: o buildx abre uma sessão gRPC e usa o caminho ABSOLUTO da pasta como
# valor do header `x-docker-expose-session-sharedkey`. Headers HTTP/2 exigem
# ASCII; o "ç" (UTF-8 multibyte) quebra com:
#   "x-docker-expose-session-sharedkey contains non-printable ASCII characters".
# SOLUÇÃO: manter o "ç" na pasta real e rodar o compose através de um symlink
# 100% ASCII (ASCII_DIR). O buildx usa a string do symlink como sharedkey →
# header válido. COMPOSE_PROJECT_NAME é fixado para o nome já existente, senão
# trocar o --project-directory recriaria volumes/containers (perda de dados).
ASCII_DIR := $(HOME)/projects/tm-ascii
export COMPOSE_PROJECT_NAME := ticketmaster_microsserviosescalaveis
DC := docker compose --project-directory $(ASCII_DIR)

# Garante (idempotente) o symlink ASCII → pasta real (com ç). Recriado se o
# alvo mudou; inofensivo se já correto.
ascii-link:
	@ln -sfn "$(CURDIR)" "$(ASCII_DIR)"
	@echo "🔗 $(ASCII_DIR) → $$(readlink $(ASCII_DIR))"

# Sobe a stack COMPLETA (builda as imagens dos serviços via BuildKit).
# Use este alvo em vez de `docker compose up -d` direto da pasta com ç.
up: ascii-link
	$(DC) up -d

down: ascii-link
	$(DC) down

# Builda todas as imagens (ou SERVICE=api-gateway p/ uma só) sem subir.
compose-build: ascii-link
	$(DC) build $(SERVICE)

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
infra-up: ascii-link
	$(DC) up postgres redis kafka kafka-ui elasticsearch -d
	@echo "⏳ Aguardando serviços ficarem saudáveis..."
	@$(DC) ps

infra-down: ascii-link
	$(DC) down

infra-logs: ascii-link
	$(DC) logs -f postgres redis kafka elasticsearch

# Sobe os serviços de observabilidade (otel-collector, prometheus, grafana, loki, tempo)
# Definidos com profiles: ["observability"] no docker-compose.yml — não sobem com make up
obs-up: ascii-link
	$(DC) --profile observability up otel-collector prometheus grafana loki tempo -d

obs-down: ascii-link
	$(DC) --profile observability down otel-collector prometheus grafana loki tempo

obs-logs: ascii-link
	$(DC) --profile observability logs -f otel-collector prometheus grafana loki tempo

# Pré-cria todos os tópicos Kafka usados pelos serviços (idempotente).
# dev-services já chama isso automaticamente — use manualmente após um
# `docker compose down -v` (que apaga o volume e zera os tópicos).
kafka-topics:
	@bash scripts/kafka-topics.sh

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

# Mesmo gate que o GitHub Actions roda no job "Security Audit":
# checa advisories vivos no registry e falha em qualquer vuln >= high.
# Para corrigir: adicione um override em package.json `pnpm.overrides` e
# regenere o lockfile com `pnpm install --lockfile-only`.
audit:
	pnpm audit --audit-level=high

# Espelho EXATO do job "Lint & Type Check" do .github/workflows/ci.yml.
# Rode antes de empurrar — passando aqui, passa no GitHub.
# (test/test-e2e ficam fora porque o CI ainda não tem Postgres/Redis no runner;
# rode `make test` separadamente quando for executar a suíte completa.)
ci: lint type-check audit
	@echo "✅ Espelho do CI passou localmente — seguro para git push"

# ─── Build & Deploy ───────────────────────────────────────────────────────────

build:
	pnpm run build

# Remove builds, node_modules e volumes Docker locais
clean: ascii-link
	pnpm run clean
	$(DC) down -v  # remove volumes de dados locais (cuidado: apaga dados!)

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
	@echo "  make dev-services Inicia serviços NestJS em background (hot reload)"
	@echo "  make dev-stop     Para os serviços iniciados por dev-services"
	@echo "  make dev-status   Status (porta + PID) dos serviços"
	@echo "  make dev-logs     Tail dos logs dos serviços"
	@echo "  make up           Sobe a stack COMPLETA (builda imagens; use no lugar"
	@echo "                    de 'docker compose up -d' por causa do ç no path)"
	@echo "  make down         Para a stack completa"
	@echo "  make compose-build Builda imagens (SERVICE=api-gateway p/ uma só)"
	@echo "  make infra-up     Sobe apenas postgres, redis, kafka, elasticsearch"
	@echo "  make infra-down   Para todos os containers"
	@echo "  make infra-logs   Tail de logs da infra"
	@echo "  make kafka-topics Pré-cria todos os tópicos Kafka (idempotente)"
	@echo "  make obs-up       Sobe observabilidade (OTEL, Prometheus, Grafana, Loki, Tempo)"
	@echo "  make obs-down     Para os serviços de observabilidade"
	@echo "  make obs-logs     Tail de logs da observabilidade"
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
	@echo "  make audit        pnpm audit --audit-level=high (mesmo do GitHub Actions)"
	@echo "  make test         Testes unitários"
	@echo "  make test-e2e     Testes E2E (Playwright)"
	@echo "  make ci           Espelho do CI (lint + type-check + audit) — rode antes do git push"
	@echo ""
	@echo "Build:"
	@echo "  make build        Build de produção de todos os serviços"
	@echo "  make clean        Remove builds e volumes locais"
	@echo ""
	@echo "GitHub (rodar uma vez após criar o repositório):"
	@echo "  make github-setup GITHUB_REPO=owner/repo"
	@echo "                    Configura branch protection na main"
	@echo ""
