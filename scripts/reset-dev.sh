#!/usr/bin/env bash
# scripts/reset-dev.sh

set -e

echo "🛑 Parando serviços NestJS..."
./scripts/dev.sh stop

echo "🧹 Limpando Redis..."
docker compose exec redis redis-cli -a redis_dev_secret FLUSHALL

echo "🐘 Limpando bancos de dados PostgreSQL (preservando Plans e Categories)..."

DATABASES=("showpass_auth" "showpass_events" "showpass_booking" "showpass_payment")

for db in "${DATABASES[@]}"; do
  echo "  - Limpando $db..."
  # Este SQL busca todas as tabelas exceto as essenciais e executa um TRUNCATE CASCADE
  docker compose exec postgres psql -U showpass -d "$db" -c \
    "DO \$\$ DECLARE r RECORD; 
     BEGIN 
       FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('plans', 'categories', '_prisma_migrations')) 
       LOOP 
         EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE'; 
       END LOOP; 
     END \$\$;"
done

echo "🚀 Resetando Kafka (Removendo e recriando tópicos)..."
docker compose stop kafka
docker compose rm -f kafka
docker compose up -d kafka

echo "✨ Sistema limpo!"
echo "Dica: Execute 'make dev-services' para iniciar o fluxo novamente."
echo "O primeiro passo deve ser o Registro de um Organizador para disparar os eventos Kafka."