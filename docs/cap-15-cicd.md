# Capítulo 15 — CI/CD (Pipeline Completo)

> **Objetivo:** Expandir o esqueleto criado no [Capítulo 1](cap-01-ambiente-monorepo.md) para o pipeline completo: build Docker multi-stage, push para ECR com Cosign, e deploy no EKS 1.35 com zero downtime.
>
> O arquivo `.github/workflows/ci.yml` criado no Capítulo 1 já cobre lint + type-check + testes. Aqui adicionamos os jobs de `build` e `deploy`.

## Passo 15.1 — Pipeline Principal

> **Este capítulo EDITA o `.github/workflows/ci.yml` existente** (criado no
> Cap 1, expandido nos caps 2 e 14). Não criamos um workflow novo — mantemos
> `name: CI` para que os *required status checks* continuem válidos.
>
> **Gotcha load-bearing:** os nomes dos jobs (`name:`) são referenciados em
> `.github/branch-protection.sh` (`required_status_checks`). **Renomear um job
> sem atualizar esse script quebra o merge de todos os PRs.** Por isso o job de
> qualidade continua `Lint & Type Check`.

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# Cancela runs anteriores do MESMO ref (economiza minutos do Actions).
# O job `deploy` sobrescreve isso com a sua própria concurrency (não cancelar
# deploy em andamento) — ver mais abaixo.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  AWS_REGION: us-east-1
  ECR_REGISTRY: ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.us-east-1.amazonaws.com

jobs:
  # ─── 1. Qualidade de Código ────────────────────────────────────────────────
  # NÃO renomear "Lint & Type Check" — referenciado em branch-protection.sh
  quality:
    name: Lint & Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # pnpm/action-setup@v4 lê a versão do campo "packageManager" do
      # package.json. NÃO declarar `with: version:` aqui — duas fontes de
      # versão causam ERR_PNPM_BAD_PM_VERSION.
      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Cache Turborepo
        uses: actions/cache@v4
        with:
          path: .turbo
          key: turbo-${{ runner.os }}-${{ github.sha }}
          restore-keys: |
            turbo-${{ runner.os }}-

      # Scripts do package.json raiz delegam ao Turborepo (turbo run X)
      - run: pnpm run lint
      - run: pnpm run type-check

      # Auditoria de segurança (OWASP A06)
      - name: Security audit
        run: pnpm audit --audit-level=high

  # ─── 2. Testes ────────────────────────────────────────────────────────────
  # NÃO renomear "Tests" — referenciado em branch-protection.sh
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
      - uses: pnpm/action-setup@v4   # sem version: (lê de packageManager)
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
        run: pnpm run test
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
        service: [api-gateway, auth-service, event-service, booking-service, payment-service, search-service, worker-service, web]

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

      # UM único bloco env: por step (duas chaves `env:` no mesmo step é YAML
      # inválido — a segunda sobrescreveria a primeira, perdendo IMAGE_TAG).
      - name: Build, sign, and push Docker image
        env:
          IMAGE_TAG: ${{ github.sha }}
          SERVICE: ${{ matrix.service }}
          COSIGN_KEY: ${{ secrets.COSIGN_PRIVATE_KEY }}
          COSIGN_PASSWORD: ${{ secrets.COSIGN_PASSWORD }}
        run: |
          # Build multi-stage (stage prod). O Dockerfile compartilhado usa
          # ARG SERVICE_NAME para selecionar o serviço.
          docker build \
            --build-arg SERVICE_NAME=$SERVICE \
            --target prod \
            --tag $ECR_REGISTRY/showpass-$SERVICE:$IMAGE_TAG \
            --tag $ECR_REGISTRY/showpass-$SERVICE:latest \
            --cache-from $ECR_REGISTRY/showpass-$SERVICE:latest \
            --file infra/docker/nestjs.Dockerfile \
            .

          # Push ANTES de assinar — Cosign assina por digest no registry
          docker push $ECR_REGISTRY/showpass-$SERVICE:$IMAGE_TAG
          docker push $ECR_REGISTRY/showpass-$SERVICE:latest

          # Assinatura keyed (OWASP A08). Mesma chave usada no `cosign verify`
          # (ver "Testando na prática"). ECR — não ghcr.
          cosign sign --yes --key env://COSIGN_KEY \
            $ECR_REGISTRY/showpass-$SERVICE:$IMAGE_TAG

  # ─── 4. Deploy no EKS ─────────────────────────────────────────────────────
  deploy:
    name: Deploy to EKS
    runs-on: ubuntu-latest
    needs: build
    environment: production
    # Sobrescreve a concurrency do workflow: nunca cancelar deploy em andamento
    concurrency:
      group: production-deploy
      cancel-in-progress: false

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
          for svc in api-gateway auth-service event-service booking-service \
                     payment-service search-service worker-service web; do
            kustomize edit set image \
              showpass-$svc=$ECR_REGISTRY/showpass-$svc:${{ github.sha }}
          done

      - name: Deploy
        run: |
          kustomize build infra/k8s/overlays/production | kubectl apply -f -

      - name: Aguardar rollout
        run: |
          # Nomes dos Deployments == nomes dos serviços (ver cap-16)
          for d in api-gateway event-service booking-service payment-service; do
            kubectl rollout status deployment/$d -n showpass --timeout=300s
          done

      - name: Smoke test pós-deploy
        run: |
          # /health/ready é agregado pelo api-gateway (checa event + booking)
          curl -sf https://api.showpass.com.br/health/ready | grep '"status":"ok"'
```

---

### Passando no gate `pnpm audit --audit-level=high` (OWASP A06)

`pnpm audit` consulta a base de advisories **ao vivo** — vulnerabilidades
recém-publicadas em deps transitivas fazem o gate falhar sem nenhuma mudança
no código. O job só quebra em severidade **high** (`--audit-level=high`);
moderate/low não bloqueiam.

A correção é forçar versões corrigidas via **`pnpm.overrides`** no
`package.json` raiz (mesmo mecanismo do `tar`):

```jsonc
// package.json (raiz)
"pnpm": {
  "overrides": {
    "tar": ">=7.5.11",
    "axios": "^1.16.1",
    "basic-ftp": ">=5.3.1",
    "fast-uri": ">=3.1.2",
    "next": ">=16.2.6",
    "js-cookie": ">=3.0.7"
  }
}
```

> **Peer dependency não respeita override de range.** `axios` é *peer* de
> `@nestjs/axios` (usado por `@nestjs/terminus` no api-gateway). O override
> sozinho não re-resolve o lockfile (fica preso na versão antiga). Solução:
> declarar `axios` como **dependência direta** de `apps/api-gateway`
> (`"axios": "^1.16.1"`) — aí o `@nestjs/axios` usa a versão patcheada.
>
> Depois de mexer em overrides/deps: `pnpm install` (regenera o
> `pnpm-lock.yaml`) e confirme com `pnpm audit --audit-level=high` (exit 0 =
> zero high). O lockfile atualizado **tem que entrar no commit** — o CI usa
> `--frozen-lockfile`.

---

### Reproduzindo o gate de CI localmente — `make ci`

Para evitar `git push` "no escuro", o `Makefile` (Cap 01) expõe um alvo
`ci` que é o **espelho exato** do job "Lint & Type Check" do GitHub Actions:

```bash
make ci    # lint + type-check + audit (--audit-level=high)
           # ✅ passando aqui → vai passar no Actions
```

Cada peça também é rodável isoladamente quando você está iterando:

```bash
make lint        # ESLint em todos os pacotes
make type-check  # tsc --noEmit em todos os pacotes
make audit       # pnpm audit --audit-level=high (mesma flag do .yml)
```

Por que `make ci` **não** inclui `make test`? O CI atual ainda não orquestra
Postgres/Redis/Kafka como serviços do runner — os testes locais dependem da
infra docker-compose. Rode `make test` em separado quando precisar (depois de
`make infra-up`); o gate do GitHub não cobre essa parte.

> **Fluxo recomendado antes de `git push`:** `make ci`. Se algo quebrar:
> `make audit` → caiu por vuln → adicione `pnpm.overrides` (este passo) +
> `pnpm install --lockfile-only`; `make lint`/`type-check` → caiu por código
> → corrija e rode de novo. Custa ~5 min e elimina o ciclo
> push → CI vermelho → fix → push.

---

## Passo 15.2 — Testes seletivos por PR

> O repositório **já tem** `.github/workflows/pr-title.yml` (criado no Cap 1):
> valida que o título do PR segue Conventional Commits via
> `amannn/action-semantic-pull-request`. **Não o substitua** — ele tem outro
> propósito. Adicionamos um workflow *separado* para testes seletivos.

`pnpm turbo run test --filter="...[origin/main]"` roda apenas os pacotes
afetados pela PR (e seus dependentes), aproveitando o cache do Turborepo —
muito mais rápido que rodar tudo:

```yaml
# .github/workflows/pr-selective-tests.yml
name: PR Selective Tests

on:
  pull_request:
    branches: [main]

jobs:
  selective-tests:
    name: Testes seletivos
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # fetch-depth: 0 — o filtro "[origin/main]" precisa do histórico
          # para calcular o diff de pacotes afetados
          fetch-depth: 0
      - uses: pnpm/action-setup@v4   # sem version: (lê de packageManager)
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run test --filter="...[origin/main]"
```

> **Por que um workflow separado e não um job em `ci.yml`?** O `ci.yml` roda
> a suíte completa (required check, bloqueia o merge). Este é um sinal
> *rápido* e informativo durante a revisão — não required, não acoplado ao
> `branch-protection.sh`.

---

## Testando na prática

O CI/CD é verificado abrindo um Pull Request real no GitHub e acompanhando os checks.

### Passo a passo

**1. Criar uma branch e abrir um PR**

```bash
git checkout -b feat/teste-ci
# Faça uma mudança pequena em qualquer arquivo (ex: adicione um comentário)
git add -A
git commit -m "test: verificar pipeline CI"
git push origin feat/teste-ci
```

Abra o PR no GitHub. A interface do Actions deve aparecer com os checks rodando.

**2. Acompanhar o pipeline no GitHub Actions**

Acesse a aba "Actions" do repositório. Em PR, rodam `quality` → `test`
sequencialmente (`test` tem `needs: quality`):

```
CI
  ├── Lint & Type Check    [running...]   (job: quality)
  └── Tests                [waiting]      (job: test, needs: quality)
PR Selective Tests
  └── Testes seletivos     [running...]   (turbo --filter=...[origin/main])
PR Title Check
  └── check-title          [passed]       (Conventional Commits)
```

Os jobs `build` (matrix de 8 serviços) e `deploy` só rodam **após merge na
`main`** (`if: github.ref == 'refs/heads/main'`), não em PR.

**3. Verificar que o Turborepo remote cache foi usado**

Na segunda execução do pipeline (ex: re-run ou novo commit pequeno), os jobs devem terminar mais rápido. No log você verá:

```
• Packages in scope: booking-service
• Running build in 1 packages
booking-service:build: cache hit, replaying output 018e...
```

Isso significa que o build não rodou novamente — o Turborepo usou o cache.

**4. Forçar uma falha de lint para ver o PR bloqueado**

Adicione um `console.log` em qualquer arquivo TypeScript:

```typescript
console.log('teste'); // ESLint vai reclamar: no-console
```

Faça commit e push. O check de lint deve falhar com:

```
error  Unexpected console statement  no-console
```

O PR fica bloqueado pela branch protection rule — não é possível fazer merge com check falhando.

**5. Verificar assinatura da imagem Docker (após merge na main)**

O job `build` assina cada imagem no **ECR** com a chave Cosign
(`cosign sign --key`). A verificação usa a **chave pública** correspondente
(modelo *keyed* — o mesmo dos dois lados, não keyless OIDC):

```bash
# COSIGN_PUBLIC_KEY = par público da COSIGN_PRIVATE_KEY usada no CI
ECR=123456789.dkr.ecr.us-east-1.amazonaws.com

cosign verify \
  --key env://COSIGN_PUBLIC_KEY \
  $ECR/showpass-booking-service:<sha-do-commit>
```

O K8s rejeita imagens sem assinatura válida (admission webhook — Kyverno/
Sigstore policy controller, configurado no cap-16).

**6. Verificar que só o serviço alterado foi testado (Turborepo affected)**

Em um PR que altera apenas `apps/auth-service/`, o pipeline deve exibir:

```
• Packages in scope: auth-service
• auth-service:test    [running]
• booking-service:test [SKIPPED] — not affected
```

O cache do Turborepo detecta o que mudou e ignora o resto.

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
