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
# Formato: "nome:porta:filtro-pnpm"
declare -A SERVICES=(
  [auth-service]="3006"
  [event-service]="3003"
  [api-gateway]="3000"
)

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

  # Aguarda o serviço subir (máx 15s)
  local i=0
  while [ $i -lt 15 ]; do
    if pid_on_port "$port" > /dev/null 2>&1; then
      echo -e "  ${GREEN}✓  $name pronto (porta $port)${RESET}"
      return
    fi
    sleep 1
    i=$((i + 1))
  done

  echo -e "  ${RED}✗  $name demorou para subir — veja: tail -f $log${RESET}"
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

cmd_start() {
  echo -e "\n${BLUE}╔══════════════════════════════════════╗"
  echo -e "║   ShowPass — Iniciando serviços      ║"
  echo -e "╚══════════════════════════════════════╝${RESET}\n"

  if [ $# -eq 0 ]; then
    # Inicia todos os serviços na ordem correta
    start_service "auth-service"
    start_service "event-service"
    start_service "api-gateway"
  else
    for svc in "$@"; do
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
  for name in auth-service event-service api-gateway; do
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
    for name in auth-service event-service api-gateway; do
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
  auth|auth-service)     cmd_start auth-service ;;
  event|event-service)   cmd_start event-service ;;
  gateway|api-gateway)   cmd_start api-gateway ;;
  *)
    echo "Uso: $0 [start|stop|status|logs|auth|event|gateway]"
    exit 1
    ;;
esac
