# Capítulo 15 — CI/CD (Pipeline Completo)

> **Objetivo:** Expandir o esqueleto criado no [Capítulo 1](cap-01-ambiente-monorepo.md) para o pipeline completo: build Docker multi-stage, push para ECR com Cosign, e deploy no EKS 1.35 com zero downtime.
>
> O arquivo `.github/workflows/ci.yml` criado no Capítulo 1 já cobre lint + type-check + testes. Aqui adicionamos os jobs de `build` e `deploy`.

## Passo 15.1 — Pipeline Principal

```yaml
# .github/workflows/ci.yml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  AWS_REGION: us-east-1
  ECR_REGISTRY: ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.us-east-1.amazonaws.com

jobs:
  # ─── 1. Qualidade de Código ────────────────────────────────────────────────
  quality:
    name: Lint & Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm run lint
      - run: pnpm run type-check

      # Auditoria de segurança (OWASP A06)
      - name: Security audit
        run: pnpm audit --audit-level=high

  # ─── 2. Testes ────────────────────────────────────────────────────────────
  test:
    name: Tests
    runs-on: ubuntu-latest
    needs: quality
    services:
      postgres:
        image: postgres:18-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: showpass_test
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-retries 5
      redis:
        image: redis:8.6-alpine
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Run migrations
        run: pnpm run db:migrate
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/showpass_test

      - name: Unit & Integration Tests
        run: pnpm run test --coverage
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/showpass_test
          REDIS_URL: redis://localhost:6379

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}

  # ─── 3. Build & Push Docker ───────────────────────────────────────────────
  build:
    name: Build Docker Images
    runs-on: ubuntu-latest
    needs: test
    if: github.ref == 'refs/heads/main'
    strategy:
      matrix:
        service: [api-gateway, event-service, booking-service, payment-service, search-service, worker-service, web]

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, and push Docker image
        env:
          IMAGE_TAG: ${{ github.sha }}
          SERVICE: ${{ matrix.service }}
        run: |
          # Build multi-stage (prod stage)
          docker build \
            --build-arg SERVICE_NAME=$SERVICE \
            --target prod \
            --tag $ECR_REGISTRY/showpass-$SERVICE:$IMAGE_TAG \
            --tag $ECR_REGISTRY/showpass-$SERVICE:latest \
            --cache-from $ECR_REGISTRY/showpass-$SERVICE:latest \
            --file infra/docker/nestjs.Dockerfile \
            .

          # Assinar a imagem com Cosign (OWASP A08)
          cosign sign --key env://COSIGN_KEY \
            $ECR_REGISTRY/showpass-$SERVICE:$IMAGE_TAG

          # Push
          docker push $ECR_REGISTRY/showpass-$SERVICE:$IMAGE_TAG
          docker push $ECR_REGISTRY/showpass-$SERVICE:latest
        env:
          COSIGN_KEY: ${{ secrets.COSIGN_PRIVATE_KEY }}

  # ─── 4. Deploy no EKS ─────────────────────────────────────────────────────
  deploy:
    name: Deploy to EKS
    runs-on: ubuntu-latest
    needs: build
    environment: production
    concurrency:
      group: production-deploy
      cancel-in-progress: false  # nunca cancelar um deploy em andamento

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Update kubeconfig
        run: |
          aws eks update-kubeconfig \
            --region ${{ env.AWS_REGION }} \
            --name showpass-production

      - name: Update image tags in Kustomize
        run: |
          cd infra/k8s/overlays/production
          kustomize edit set image \
            showpass-api-gateway=$ECR_REGISTRY/showpass-api-gateway:${{ github.sha }} \
            showpass-event-service=$ECR_REGISTRY/showpass-event-service:${{ github.sha }} \
            showpass-booking-service=$ECR_REGISTRY/showpass-booking-service:${{ github.sha }}
          # ... outros serviços

      - name: Deploy
        run: |
          kustomize build infra/k8s/overlays/production | kubectl apply -f -

      - name: Aguardar rollout
        run: |
          kubectl rollout status deployment/api-gateway -n showpass --timeout=300s
          kubectl rollout status deployment/event-service -n showpass --timeout=300s
          kubectl rollout status deployment/booking-service -n showpass --timeout=300s

      - name: Smoke test pós-deploy
        run: |
          curl -sf https://api.showpass.com.br/health/ready | grep '"status":"ok"'
```

---

## Passo 15.2 — PR Checks

```yaml
# .github/workflows/pr-checks.yml
name: PR Checks

on:
  pull_request:
    branches: [main]

jobs:
  changed-services:
    name: Detectar serviços alterados
    runs-on: ubuntu-latest
    outputs:
      services: ${{ steps.filter.outputs.changes }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            booking-service:
              - 'apps/booking-service/**'
            event-service:
              - 'apps/event-service/**'
            shared:
              - 'packages/**'

  # Rodar testes apenas dos serviços afetados pela PR (Turborepo cache)
  selective-tests:
    name: Testes seletivos
    runs-on: ubuntu-latest
    needs: changed-services
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run test --filter="...[origin/main]"
```

---

## Recapitulando

1. **Matrix build** — build paralelo de todos os serviços no GitHub Actions; sem gargalo
2. **Docker multi-stage** — imagem de produção sem devDependencies; tamanho mínimo
3. **Cosign** — assina imagens Docker; qualquer imagem não assinada é rejeitada no K8s
4. **Turborepo cache** — testes seletivos na PR; só roda o que mudou
5. **`concurrency: cancel-in-progress: false`** — nunca cancela um deploy em andamento (evita estado inconsistente)

---

## Próximo capítulo

[Capítulo 16 → Kubernetes & Terraform](cap-16-kubernetes-terraform.md)
