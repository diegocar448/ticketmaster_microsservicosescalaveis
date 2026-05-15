#!/usr/bin/env bash
# scripts/dev.sh
#
# Inicia os microserviços NestJS em modo desenvolvimento.
# Cada serviço roda em background com logs em /tmp/showpass-*.log
#
# Uso:
#   ./scripts/dev.sh            → inicia serviços do capítulo atual
#   ./scripts/dev.sh auth       → inicia só o auth-service
#   ./scripts/dev.sh logs       → mostra logs de todos os serviços
#   ./scripts/dev.sh stop       → para todos os serviços
#   ./scripts/dev.sh status     → mostra o que está rodando

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="/tmp/showpass-logs"
mkdir -p "$LOG_DIR"

# ─── Serviços disponíveis ──────────────────────────────────────────────────────
# Formato: "nome:porta". Para adicionar um novo serviço ver:
# docs/cap-01-ambiente-monorepo.md → "Como adicionar um novo microsserviço ao dev.sh"
#
# IMPORTANTE: a ORDEM do array START_ORDER abaixo define a sequência de boot.
# Dependências de fato (Kafka replication) → auth primeiro, gateway último.
declare -A SERVICES=(
  [auth-service]="3006"
  [event-service]="3003"
  [booking-service]="3004"
  [payment-service]="3002"
  [api-gateway]="3000"
)

# Ordem determinística para iterar (bash associative arrays não preservam ordem).
START_ORDER=(auth-service event-service booking-service payment-service api-gateway)

# ─── Cores ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; RESET='\033[0m'

# ─── Helpers ──────────────────────────────────────────────────────────────────

pid_on_port() {
  lsof -ti :"$1" 2>/dev/null | head -1 || true
}

service_running() {
  local port="${SERVICES[$1]}"
  [ -n "$(pid_on_port "$port")" ]
}

start_service() {
  local name="$1"
  local port="${SERVICES[$name]}"
  local log="$LOG_DIR/$name.log"

  if service_running "$name"; then
    echo -e "  ${YELLOW}⏭  $name já está rodando na porta $port${RESET}"
    return
  fi

  echo -e "  ${CYAN}▶  Iniciando $name (porta $port)...${RESET}"
  (
    cd "$ROOT/apps/$name"
    npm run dev >> "$log" 2>&1
  ) &

  # Aguarda o serviço amarrar a porta. Serviços com Kafka (event/booking/payment)
  # demoram ~14s: consumer group join (~4s) + Prisma (~3s) + boot Nest.
  # 45s dá margem para primeiro boot em máquinas lentas + Kafka rebalance.
  local max_wait=45
  local i=0
  while [ $i -lt $max_wait ]; do
    if pid_on_port "$port" > /dev/null 2>&1; then
      echo -e "  ${GREEN}✓  $name pronto (porta $port, ${i}s)${RESET}"
      return
    fi
    sleep 1
    i=$((i + 1))
  done

  echo -e "  ${RED}✗  $name demorou ${max_wait}s para subir — veja: tail -f $log${RESET}"
}

stop_service() {
  local name="$1"
  local port="${SERVICES[$name]}"
  local pid
  pid=$(pid_on_port "$port")

  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    echo -e "  ${RED}■  $name parado (porta $port, PID $pid)${RESET}"
  else
    echo -e "  ${YELLOW}⏭  $name não estava rodando${RESET}"
  fi
}

# ─── Comandos ─────────────────────────────────────────────────────────────────

ensure_kafka_topics() {
  # Pré-cria tópicos ANTES de subir consumers. Evita UNKNOWN_TOPIC_OR_PARTITION
  # no startup de event/booking/payment que têm `allowAutoTopicCreation: false`.
  if [ -x "$ROOT/scripts/kafka-topics.sh" ]; then
    echo -e "  ${CYAN}⚙  Garantindo tópicos Kafka...${RESET}"
    "$ROOT/scripts/kafka-topics.sh" >/dev/null 2>&1 || \
      echo -e "  ${YELLOW}⚠  Falha ao criar tópicos (infra rodando? make infra-up)${RESET}"
  fi
}

cmd_start() {
  echo -e "\n${BLUE}╔══════════════════════════════════════╗"
  echo -e "║   ShowPass — Iniciando serviços      ║"
  echo -e "╚══════════════════════════════════════╝${RESET}\n"

  ensure_kafka_topics

  if [ $# -eq 0 ]; then
    # Inicia todos os serviços na ordem correta (ver START_ORDER no topo)
    for svc in "${START_ORDER[@]}"; do
      start_service "$svc"
    done
  else
    for svc in "$@"; do
      # Aceita aliases curtos (auth, event, booking, payment, gateway)
      case "$svc" in
        auth)    svc=auth-service ;;
        event)   svc=event-service ;;
        booking) svc=booking-service ;;
        payment) svc=payment-service ;;
        gateway) svc=api-gateway ;;
      esac
      if [ -v "SERVICES[$svc]" ]; then
        start_service "$svc"
      else
        echo -e "  ${RED}✗  Serviço desconhecido: $svc${RESET}"
        echo -e "  Disponíveis: ${!SERVICES[*]}"
      fi
    done
  fi

  echo -e "\n${GREEN}Serviços iniciados!${RESET}"
  echo -e "  Swagger UI:  ${CYAN}http://localhost:3000/docs${RESET}"
  echo -e "  Auth:        ${CYAN}http://localhost:3006/auth${RESET}"
  echo -e "  Events:      ${CYAN}http://localhost:3003/events${RESET}"
  echo -e "  Bookings:    ${CYAN}http://localhost:3004/bookings/reservations${RESET}"
  echo -e "  Payments:    ${CYAN}http://localhost:3002/payments/orders${RESET}"
  echo -e "  Logs:        ${CYAN}$LOG_DIR/${RESET}"
  echo -e "\n  Para ver logs: ${YELLOW}./scripts/dev.sh logs${RESET}"
  echo -e "  Para parar:   ${YELLOW}./scripts/dev.sh stop${RESET}\n"
}

cmd_stop() {
  echo -e "\n${BLUE}Parando serviços...${RESET}\n"
  for name in "${!SERVICES[@]}"; do
    stop_service "$name"
  done
  echo ""
}

cmd_status() {
  echo -e "\n${BLUE}Status dos serviços:${RESET}\n"
  for name in "${START_ORDER[@]}"; do
    local port="${SERVICES[$name]}"
    local pid
    pid=$(pid_on_port "$port")
    if [ -n "$pid" ]; then
      echo -e "  ${GREEN}●${RESET} $name  (porta $port, PID $pid)"
    else
      echo -e "  ${RED}○${RESET} $name  (porta $port — parado)"
    fi
  done
  echo ""
}

cmd_logs() {
  local filter="${1:-}"
  if [ -n "$filter" ] && [ -v "SERVICES[$filter]" ]; then
    tail -f "$LOG_DIR/$filter.log"
  else
    # Mostra as últimas 20 linhas de cada serviço
    for name in "${START_ORDER[@]}"; do
      local log="$LOG_DIR/$name.log"
      if [ -f "$log" ]; then
        echo -e "\n${CYAN}─── $name ───${RESET}"
        tail -5 "$log"
      fi
    done
  fi
}

# ─── Entrada ──────────────────────────────────────────────────────────────────

case "${1:-start}" in
  start)   shift; cmd_start "$@" ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  logs)    shift; cmd_logs "${1:-}" ;;
  auth|auth-service)       cmd_start auth-service ;;
  event|event-service)     cmd_start event-service ;;
  booking|booking-service) cmd_start booking-service ;;
  payment|payment-service) cmd_start payment-service ;;
  gateway|api-gateway)     cmd_start api-gateway ;;
  *)
    echo "Uso: $0 [start|stop|status|logs|auth|event|booking|payment|gateway]"
    exit 1
    ;;
esac
