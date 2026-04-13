# infra/ — Gotchas para Claude

## Regra de ouro
NUNCA sugerir ou executar comandos destrutivos sem confirmação explícita do usuário:
- `terraform destroy`
- `kubectl delete namespace showpass`
- `kubectl delete pvc`
- `aws rds delete-db-instance`

## Terraform

### Estado remoto — não editar manualmente
Backend S3: `showpass-terraform-state` / `production/terraform.tfstate`
Lock DynamoDB: `showpass-terraform-locks`
Nunca fazer `terraform state rm` ou `terraform import` sem entender o impacto.

### Versões fixas
`required_version = ">= 1.14.8"` — não baixar.
EKS cluster_version = "1.35" — upgrade requer plano de migração.

### RDS em produção
`deletion_protection = true` — proposital. Para desativar precisa de PR aprovado.
`multi_az = true` em produção — nunca remover.

## Kubernetes

### Namespace showpass
Todos os recursos ficam em `namespace: showpass`.
NUNCA criar recursos em `default`.

### HPA do booking-service
`minReplicas: 3, maxReplicas: 50`
`scaleUp.stabilizationWindowSeconds: 30` — rápido em picos (show do Bruno Mars)
`scaleDown.stabilizationWindowSeconds: 300` — lento para descer (evita flapping)
Não reduzir minReplicas abaixo de 3 em produção.

### Worker Service — escala VERTICAL
Worker usa Puppeteer (Chrome headless) — CPU/RAM intensivo.
`limits: memory: 4Gi, cpu: 2000m`
Não aumentar replicas além do número de partições Kafka do tópico.

## Redis Cluster Sentinel HA
Produção: 3 nós (1 primary + 2 replicas) via ElastiCache.
Sentinel detecta falha e promove replica automaticamente (< 30s de downtime).
Dev: instância única no docker-compose (sem HA — ok para desenvolvimento).

## Secrets
Secrets Kubernetes vêm do AWS Secrets Manager via External Secrets Operator.
NUNCA criar Secret com valor hardcoded no manifesto YAML.
