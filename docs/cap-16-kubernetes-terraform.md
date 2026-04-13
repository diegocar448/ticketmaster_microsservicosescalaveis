# Capítulo 16 — Kubernetes & Terraform

> **Objetivo:** Deploy production-ready no EKS com HPA (auto-scaling), Kustomize overlays para múltiplos ambientes, e infraestrutura AWS via Terraform.

## Passo 16.1 — Deployment do Booking Service (K8s)

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
        prometheus.io/port: "3003"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: booking-service-sa
      # Não rodar como root (OWASP A05)
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: booking-service
          image: showpass-booking-service:latest  # sobrescrito pelo Kustomize
          ports:
            - containerPort: 3003
          env:
            - name: NODE_ENV
              value: production
            - name: PORT
              value: "3003"
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
              port: 3003
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 3003
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
