# infra/terraform/main.tf
#
# Infraestrutura AWS do ShowPass: VPC, EKS 1.35, RDS PostgreSQL 18,
# ElastiCache Redis 8. Estado remoto no S3 + lock no DynamoDB.
#
# Ver infra/CLAUDE.md: NUNCA `terraform destroy` sem confirmação; RDS de
# produção tem deletion_protection = true.

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

locals {
  common_tags = {
    Project     = "ShowPass"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
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
  # single_nat_gateway em não-produção economiza custo (1 NAT em vez de 3)
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

    # Nós otimizados para o Booking Service (CPU intensivo).
    # taint dedicado: só pods que toleram workload=booking agendam aqui.
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

# ─── Subnet groups (RDS + ElastiCache) ────────────────────────────────────────
resource "aws_db_subnet_group" "main" {
  name       = "showpass-${var.environment}-rds"
  subnet_ids = module.vpc.private_subnets
  tags       = local.common_tags
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "showpass-${var.environment}-redis"
  subnet_ids = module.vpc.private_subnets
}

# ─── Security groups ──────────────────────────────────────────────────────────
# RDS: só aceita conexões da VPC na porta 5432 (Postgres).
resource "aws_security_group" "rds" {
  name        = "showpass-${var.environment}-rds"
  description = "Permite Postgres apenas de dentro da VPC"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description = "PostgreSQL from VPC"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [module.vpc.vpc_cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

# Redis: só aceita conexões da VPC na porta 6379.
resource "aws_security_group" "redis" {
  name        = "showpass-${var.environment}-redis"
  description = "Permite Redis apenas de dentro da VPC"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description = "Redis from VPC"
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [module.vpc.vpc_cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
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
  password   = var.db_password # gerenciado pelo AWS Secrets Manager

  allocated_storage     = 100
  max_allocated_storage = 1000 # autoscaling de storage

  multi_az                = var.environment == "production"
  deletion_protection     = var.environment == "production"
  skip_final_snapshot     = var.environment != "production"
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
  description          = "Redis para locks distribuidos e cache"

  node_type          = "cache.r6g.large"
  num_cache_clusters = var.environment == "production" ? 3 : 1
  engine_version     = "8.6"

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  tags = local.common_tags
}
