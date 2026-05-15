#!/usr/bin/env bash
# scripts/kafka-topics.sh
#
# Cria (idempotentemente) todos os tópicos Kafka usados pelos microsserviços.
# Por que manual? Os clients KafkaJS rodam com `allowAutoTopicCreation: false`
# — se um consumer subir antes do tópico existir, falha com UNKNOWN_TOPIC_OR_PARTITION
# e derruba o serviço. Pré-criar evita essa corrida.
#
# Performance: um único `docker exec ... bash` via stdin evita N cold starts
# de JVM. 17 tópicos caem de ~85s para ~5s.
#
# Uso:
#   ./scripts/kafka-topics.sh          # cria todos os tópicos
#   ./scripts/kafka-topics.sh --list   # apenas lista os tópicos existentes

set -euo pipefail

KAFKA_CONTAINER="${KAFKA_CONTAINER:-ticketmaster_microsserviosescalaveis-kafka-1}"
BOOTSTRAP="${KAFKA_BOOTSTRAP:-localhost:9092}"

# Lista dos tópicos — manter em sincronia com packages/types/src/kafka-topics.ts
TOPICS=(
  bookings.reservation-created
  bookings.reservation-expired
  bookings.reservation-cancelled
  payments.order-created
  payments.payment-confirmed
  payments.payment-failed
  payments.refund-processed
  events.event-published
  events.event-updated
  events.event-cancelled
  events.ticket-batch-created
  events.ticket-batch-updated
  events.ticket-batch-deleted
  auth.organizer-created
  auth.organizer-updated
  auth.buyer-created
  auth.buyer-updated
)

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; RESET='\033[0m'

if ! docker ps --format '{{.Names}}' | grep -q "^${KAFKA_CONTAINER}$"; then
  echo -e "${RED}✗  Container '${KAFKA_CONTAINER}' não está rodando. Suba com: make infra-up${RESET}"
  exit 1
fi

if [ "${1:-}" = "--list" ]; then
  echo -e "${CYAN}Tópicos atuais no broker:${RESET}"
  docker exec "$KAFKA_CONTAINER" /opt/kafka/bin/kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --list
  exit 0
fi

echo -e "${CYAN}Criando tópicos Kafka (idempotente)...${RESET}"

# Gera um script bash e pipe para o container via stdin.
# Dessa forma não precisamos escapar $ e quotes no `bash -c`.
{
  echo "set -u"
  echo "existing=\$(/opt/kafka/bin/kafka-topics.sh --bootstrap-server $BOOTSTRAP --list 2>/dev/null)"
  for t in "${TOPICS[@]}"; do
    cat <<EOF
if echo "\$existing" | grep -qx "$t"; then
  echo "EXISTS $t"
elif /opt/kafka/bin/kafka-topics.sh --bootstrap-server $BOOTSTRAP --create --if-not-exists --partitions 1 --replication-factor 1 --topic "$t" >/dev/null 2>&1; then
  echo "CREATED $t"
else
  echo "FAIL $t"
fi
EOF
  done
} | docker exec -i "$KAFKA_CONTAINER" bash 2>/dev/null | while read -r status name; do
  case "$status" in
    CREATED) echo -e "  ${GREEN}✓${RESET} $name" ;;
    EXISTS)  echo -e "  ${YELLOW}·${RESET} $name (já existia)" ;;
    FAIL)    echo -e "  ${RED}✗${RESET} $name" ;;
  esac
done

echo -e "\n${GREEN}Tópicos prontos.${RESET}"
