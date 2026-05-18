# Capítulo 16 — Kubernetes & Terraform

> **Objetivo:** Deploy production-ready no EKS com HPA (auto-scaling), Kustomize overlays para múltiplos ambientes, e infraestrutura AWS via Terraform.

## Passo 16.1 — Deployment do Booking Service (K8s)

> **Porta do booking-service = `3004`** (o Dockerfile faz `EXPOSE 3004`; o
> api-gateway checa `http://booking-service:3004/health/live`). Não confundir
> com `3003`, que é o event-service.
>
> **Pré-requisito — `/health/ready` no booking-service:** o `readinessProbe`
> abaixo usa `/health/ready`. Hoje o booking-service só expõe `/health/live`.
> Antes de aplicar este manifesto, adicione um `@Get('ready')` ao
> `health.controller.ts` do booking-service que cheque dependências (Redis +
> Postgres) — exatamente o padrão que o api-gateway já usa no seu
> `/health/ready` agregado. `live` = "o processo está vivo"; `ready` = "consigo
> atender tráfego" (deps OK). Sem essa distinção, o K8s manda tráfego para um
> pod que ainda não conectou no Redis.

```yaml
# infra/k8s/base/booking-service/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: booking-service
  namespace: showpass
  labels:
    app: booking-service
    version: "1.0"
spec:
  replicas: 3  # sobrescrito pelo HPA
  selector:
    matchLabels:
      app: booking-service
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0    # zero downtime: sempre manter N pods disponíveis
  template:
    metadata:
      labels:
        app: booking-service
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3004"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: booking-service-sa
      # Não rodar como root (OWASP A05).
      # A imagem (infra/docker/nestjs.Dockerfile) cria o usuário `appuser` via
      # `adduser -S` — UID atribuído pelo Alpine, NÃO 1000. Por isso NÃO
      # fixamos runAsUser/fsGroup numéricos (causaria mismatch com o filesystem
      # da imagem). `runAsNonRoot: true` já garante a invariante de segurança;
      # o USER do Dockerfile é honrado. Para pinar UID, o Dockerfile teria que
      # criar o usuário com `adduser -u 1000`.
      securityContext:
        runAsNonRoot: true
      containers:
        - name: booking-service
          image: showpass-booking-service:latest  # sobrescrito pelo Kustomize
          ports:
            - containerPort: 3004
          env:
            - name: NODE_ENV
              value: production
            - name: PORT
              value: "3004"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: booking-service-secrets
                  key: database-url
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: shared-secrets
                  key: redis-url
            - name: KAFKA_BROKERS
              valueFrom:
                configMapKeyRef:
                  name: kafka-config
                  key: brokers
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          # Kubernetes verifica estes endpoints para decidir o estado do pod
          livenessProbe:
            httpGet:
              path: /health/live
              port: 3004
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health/ready   # ver pré-requisito no topo deste passo
              port: 3004
            initialDelaySeconds: 5
            periodSeconds: 5
          # Graceful shutdown: aguardar requests em andamento finalizarem
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sleep", "5"]
          terminationGracePeriodSeconds: 30
```

---

## Passo 16.2 — HPA (Horizontal Pod Autoscaler)

```yaml
# infra/k8s/base/booking-service/hpa.yaml
#
# O booking-service é o serviço mais crítico em picos de demanda.
# Durante o show do Bruno Mars, ele pode escalar de 3 para 50 pods em minutos.

apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: booking-service-hpa
  namespace: showpass
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: booking-service
  minReplicas: 3    # mínimo: sempre disponível
  maxReplicas: 50   # máximo: durante picos como shows de Bruno Mars
  metrics:
    # Escalar baseado em CPU
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70   # escalar quando CPU > 70%
    # Escalar baseado em memória
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30   # escalar rápido em picos
      policies:
        - type: Pods
          value: 10                    # adicionar até 10 pods de uma vez
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300  # escalar para baixo devagar (5 min)
      policies:
        - type: Pods
          value: 2                     # remover no máximo 2 pods por vez
          periodSeconds: 60
```

---

## Passo 16.3 — Kustomize Overlays

```yaml
# infra/k8s/overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: showpass

resources:
  - ../../base

# Sobrescrever imagens com as tags do CI
images:
  - name: showpass-api-gateway
    newName: 123456789.dkr.ecr.us-east-1.amazonaws.com/showpass-api-gateway
    newTag: latest  # sobrescrito pelo CI com o SHA do commit
  - name: showpass-booking-service
    newName: 123456789.dkr.ecr.us-east-1.amazonaws.com/showpass-booking-service
    newTag: latest

# Patches de produção: mais réplicas, mais recursos
patches:
  - target:
      kind: Deployment
      name: booking-service
    patch: |
      - op: replace
        path: /spec/replicas
        value: 5
  - target:
      kind: Deployment
      name: api-gateway
    patch: |
      - op: replace
        path: /spec/template/spec/containers/0/resources/limits/memory
        value: "1Gi"
```

E o overlay de **staging** — usado nos testes locais com `kind` (Passo
"Testando na prática"). Mesmo `base`, menos réplicas, imagens sem ECR
(carregadas direto no kind):

```yaml
# infra/k8s/overlays/staging/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: showpass

resources:
  - ../../base

# Em kind, as imagens são carregadas localmente (kind load docker-image),
# então mantemos o nome local sem o registry ECR.
images:
  - name: showpass-booking-service
    newName: showpass-booking-service
    newTag: latest

# Staging: 1 réplica por serviço (economia de recursos no cluster local)
patches:
  - target:
      kind: Deployment
      name: booking-service
    patch: |
      - op: replace
        path: /spec/replicas
        value: 1
```

---

## Passo 16.4 — Terraform: EKS Cluster

```hcl
# infra/terraform/main.tf

terraform {
  required_version = ">= 1.14.8"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Estado remoto no S3 — compartilhado entre o time
  backend "s3" {
    bucket         = "showpass-terraform-state"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "showpass-terraform-locks"
  }
}

provider "aws" {
  region = var.aws_region
}

# ─── VPC ──────────────────────────────────────────────────────────────────────
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "showpass-${var.environment}"
  cidr = "10.0.0.0/16"

  azs             = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = var.environment != "production"

  tags = local.common_tags
}

# ─── EKS ──────────────────────────────────────────────────────────────────────
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "showpass-${var.environment}"
  cluster_version = "1.35"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # Node groups por tipo de workload
  eks_managed_node_groups = {
    # Nós gerais (API Gateway, Event Service, etc.)
    general = {
      instance_types = ["t3.medium"]
      min_size       = 2
      max_size       = 10
      desired_size   = 3
    }

    # Nós otimizados para o Booking Service (CPU intensivo)
    booking = {
      instance_types = ["c6i.xlarge"]
      min_size       = 2
      max_size       = 20
      desired_size   = 3

      labels = { workload = "booking" }
      taints = [{
        key    = "workload"
        value  = "booking"
        effect = "NO_SCHEDULE"
      }]
    }
  }

  tags = local.common_tags
}

# ─── RDS PostgreSQL 18 ────────────────────────────────────────────────────────
resource "aws_db_instance" "postgres" {
  engine         = "postgres"
  engine_version = "18"
  instance_class = "db.r6g.large"

  identifier = "showpass-${var.environment}"
  db_name    = "showpass"
  username   = "showpass"
  password   = var.db_password  # gerenciado pelo AWS Secrets Manager

  allocated_storage     = 100
  max_allocated_storage = 1000  # autoscaling de storage

  multi_az               = var.environment == "production"
  deletion_protection    = var.environment == "production"
  skip_final_snapshot    = var.environment != "production"
  backup_retention_period = 7

  vpc_security_group_ids = [aws_security_group.rds.id]
  db_subnet_group_name   = aws_db_subnet_group.main.name

  # Performance Insights para monitorar slow queries
  performance_insights_enabled = true

  tags = local.common_tags
}

# ─── ElastiCache Redis 8 ──────────────────────────────────────────────────────
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "showpass-${var.environment}"
  description          = "Redis para locks distribuídos e cache"

  node_type            = "cache.r6g.large"
  num_cache_clusters   = var.environment == "production" ? 3 : 1
  engine_version       = "8.6"

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  tags = local.common_tags
}

locals {
  common_tags = {
    Project     = "ShowPass"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}
```

---

## Testando na prática

Para testar localmente sem custo AWS, use o [kind](https://kind.sigs.k8s.io/) (Kubernetes in Docker) ou [minikube](https://minikube.sigs.k8s.io/). Para testar o Terraform é necessário uma conta AWS (custos mínimos em free tier).

### Testando os manifests K8s com kind (local)

**1. Instalar kind e criar o cluster**

```bash
# Instalar kind
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.25.0/kind-linux-amd64
chmod +x ./kind && sudo mv ./kind /usr/local/bin/kind

# Criar cluster local
kind create cluster --name showpass
kubectl config use-context kind-showpass
```

**2. Aplicar o overlay de staging**

```bash
kubectl apply -k infra/k8s/overlays/staging
```

**3. Verificar que o deploy subiu**

```bash
kubectl get pods -n showpass
```

Saída esperada:

```
NAME                              READY   STATUS    RESTARTS
booking-service-7d9f8b6b5-xkp2q   1/1     Running   0
```

> O overlay de staging usa `replicas: 1` (Passo 16.3) — por isso um único
> pod. Em produção o overlay sobe mais réplicas e o HPA assume o controle.

**4. Verificar o RollingUpdate**

Em `kind` a imagem é local (carregada via `kind load docker-image
showpass-booking-service:v2 --name showpass`). Simule o deploy de uma nova
tag:

```bash
kubectl set image deployment/booking-service \
  booking-service=showpass-booking-service:v2 \
  -n showpass
```

> Em produção (não-kind), a imagem viria do ECR
> (`$ECR/showpass-booking-service:<sha>`) e o `kubectl set image` é feito
> pelo job `deploy` do `ci.yml` via `kustomize edit set image` (cap-15) —
> nunca manualmente.

Observe o rollout sem downtime:

```bash
kubectl rollout status deployment/booking-service -n showpass
# Waiting for deployment "booking-service" rollout to finish: 1 out of 2 updated...
# deployment "booking-service" successfully rolled out
```

**5. Testar o HPA (escalonamento automático)**

> **Pré-requisito — `Service`:** `http://booking-service/...` resolve via um
> `Service` ClusterIP chamado `booking-service` (porta 80 → `targetPort: 3004`).
> O `base/` precisa de um `service.yaml` por serviço além do `deployment.yaml`:
> ```yaml
> # infra/k8s/base/booking-service/service.yaml
> apiVersion: v1
> kind: Service
> metadata: { name: booking-service, namespace: showpass }
> spec:
>   selector: { app: booking-service }
>   ports: [{ port: 80, targetPort: 3004 }]
> ```
> Sem o Service, o `wget http://booking-service/...` abaixo falha com DNS.
> O HPA também precisa do **metrics-server** instalado no kind
> (`kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`
> com `--kubelet-insecure-tls` em ambiente local).

```bash
# Verificar estado do HPA
kubectl get hpa -n showpass

# Gerar carga para disparar o escalonamento
kubectl run -it --rm load --image=busybox --restart=Never -- \
  sh -c "while true; do wget -q -O- http://booking-service/health/live; done"
```

Após ~30 segundos, `kubectl get pods -n showpass` deve mostrar novos pods sendo criados.

**6. Testar Liveness e Readiness probes**

```bash
# Ver os probes configurados
kubectl describe pod <nome-do-pod> -n showpass | grep -A5 "Liveness\|Readiness"
```

Para simular falha:

```bash
# Entrar no pod e derrubar o processo
kubectl exec -it <nome-do-pod> -n showpass -- kill 1
# O K8s detecta via liveness probe e reinicia o container automaticamente
kubectl get pods -n showpass --watch
```

### Testando o Terraform (requer conta AWS)

**1. Inicializar e visualizar o plano**

```bash
cd infra/terraform
terraform init
terraform plan -var-file="staging.tfvars" -out=tfplan
```

O `terraform plan` **não aplica nada** — apenas mostra o que seria criado. Revise antes de prosseguir.

**2. Aplicar em staging**

```bash
terraform apply tfplan
```

Tempo estimado: 15–20 minutos para criar VPC, EKS, RDS, ElastiCache.

**3. Verificar estado remoto no S3**

```bash
aws s3 ls s3://showpass-terraform-state/staging/
```

O arquivo `terraform.tfstate` fica no S3, compartilhado com toda a equipe.

**4. Destruir o ambiente (evitar custos)**

```bash
terraform destroy -var-file="staging.tfvars"
```

> **Atenção:** Em produção, o RDS tem `deletion_protection = true`. Antes de destruir, desabilite manualmente no console AWS.

---

## Recapitulando

1. **RollingUpdate com `maxUnavailable: 0`** — zero downtime; sempre N pods disponíveis durante deploy
2. **HPA com `scaleUp` rápido e `scaleDown` lento** — responde a picos em 30s, evita flapping
3. **Node groups separados** — pods do booking-service em nós dedicados (`c6i.xlarge`); não competem com outros workloads
4. **Kustomize overlays** — base compartilhada; produção sobrescreve apenas o que precisa
5. **Terraform backend no S3 + DynamoDB** — estado remoto compartilhado; locks evitam conflitos em time
6. **`deletion_protection = true` em produção** — protege o RDS de exclusão acidental

---

## Próximo capítulo

[Capítulo 17 → Observabilidade](cap-17-observabilidade.md)
