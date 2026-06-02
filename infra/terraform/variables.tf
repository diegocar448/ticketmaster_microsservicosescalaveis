# infra/terraform/variables.tf

variable "aws_region" {
  description = "Região AWS onde a infraestrutura é provisionada"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Ambiente: production | staging. Controla multi_az, NAT, deletion_protection."
  type        = string

  validation {
    condition     = contains(["production", "staging"], var.environment)
    error_message = "environment deve ser 'production' ou 'staging'."
  }
}

variable "db_password" {
  description = "Senha do RDS PostgreSQL. Vem do AWS Secrets Manager — NUNCA commitar."
  type        = string
  sensitive   = true
}
