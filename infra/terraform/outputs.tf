# infra/terraform/outputs.tf
#
# Outputs consumidos por: kubeconfig (deploy do ci.yml), External Secrets
# Operator (endpoints de RDS/Redis), e debug operacional.

output "cluster_name" {
  description = "Nome do cluster EKS (usado em aws eks update-kubeconfig)"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "Endpoint da API do cluster EKS"
  value       = module.eks.cluster_endpoint
}

output "rds_endpoint" {
  description = "Endpoint do RDS PostgreSQL (host:port)"
  value       = aws_db_instance.postgres.endpoint
}

output "redis_primary_endpoint" {
  description = "Endpoint primário do ElastiCache Redis"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "vpc_id" {
  description = "ID da VPC criada"
  value       = module.vpc.vpc_id
}
