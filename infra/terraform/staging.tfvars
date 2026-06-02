# infra/terraform/staging.tfvars
#
# Valores do ambiente de staging. Aplicar com:
#   terraform plan  -var-file="staging.tfvars" -out=tfplan
#   terraform apply tfplan
#
# db_password NÃO fica aqui — passe via -var ou TF_VAR_db_password
# (vem do AWS Secrets Manager). Commitar senha = vazamento.

aws_region  = "us-east-1"
environment = "staging"
