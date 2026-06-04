# Guia de Testes — ShowPass

> **Objetivo:** reproduzir do zero todos os fluxos implementados nos capítulos,
> validando tanto o comportamento visual (browser) quanto a integridade técnica
> (API, observabilidade, CI).
>
> Execute cada passo **na ordem** — dependências de dados entre seções são indicadas.

---

## Índice

1. [Pré-requisitos](#1-pré-requisitos)
2. [Setup inicial (primeira vez)](#2-setup-inicial-primeira-vez)
3. [Subir o stack de desenvolvimento](#3-subir-o-stack-de-desenvolvimento)
4. [Fluxo 1 — Home e tela de login](#4-fluxo-1--home-e-tela-de-login)
5. [Fluxo 2 — Cadastro e login como Organizer](#5-fluxo-2--cadastro-e-login-como-organizer)
6. [Fluxo 3 — Painel do Organizador (dashboard)](#6-fluxo-3--painel-do-organizador-dashboard)
7. [Fluxo 4 — Cadastro e login como Comprador](#7-fluxo-4--cadastro-e-login-como-comprador)
8. [Fluxo 5 — Proteção de rotas e auto-redirect](#8-fluxo-5--proteção-de-rotas-e-auto-redirect)
9. [Fluxo 6 — Loading spinner (comportamento padrão)](#9-fluxo-6--loading-spinner-comportamento-padrão)
10. [Fluxo 7 — Tema dark/light](#10-fluxo-7--tema-darklight)
11. [Fluxo 8 — Logout correto (sem 401/404 no Network)](#11-fluxo-8--logout-correto-sem-401404-no-network)
12. [Fluxo 9 — Observabilidade (métricas + traces + logs)](#12-fluxo-9--observabilidade-métricas--traces--logs)
13. [Testes automatizados (CI local)](#13-testes-automatizados-ci-local)
14. [Portas e URLs de referência](#14-portas-e-urls-de-referência)
15. [Troubleshooting](#troubleshooting)

---

## 1. Pré-requisitos

```bash
# Verificar versões mínimas
docker --version          # ≥ 29.1
docker compose version    # ≥ 2.x
node --version            # ≥ 20 (projeto usa 22 LTS em prod)
pnpm --version            # ≥ 9

# Clonar (se não tiver)
git clone <repo>
cd ticketmaster_microsserviçosescalaveis
```

---

## 2. Setup inicial (primeira vez)

Execute **uma única vez** em um clone limpo:

```bash
# 1. Copia todos os .env.example → .env
make copy-env

# 2. Gera o par de chaves RSA 4096-bit (auth-service → chave privada;
#    todos os outros serviços e o web recebem a chave pública).
#    Pré-requisito: ter rodado copy-env antes.
make gen-keys
```

> **Por que gen-keys é obrigatório?** O auth-service assina JWTs com RS256
> (chave privada). O api-gateway e o web verificam com a chave pública. Sem as
> chaves, o login e a proteção de rotas não funcionam.

```bash
# 3. Instala todas as dependências do monorepo
pnpm install

# 4. Sobe a infra (postgres, redis, kafka, elasticsearch)
make infra-up

# 5. Aguarda o kafka ficar healthy (~30s) e cria todos os tópicos
make kafka-topics

# 6. Roda as migrations em todos os bancos
make db-migrate

# 7. (Opcional) Popula dados iniciais (planos, categorias)
make db-seed
```

Resultado esperado em `make db-migrate`:
```
No pending migrations to apply.   ← para cada serviço
```

---

## 3. Subir o stack de desenvolvimento

Abra **4 terminais** (ou use tmux/screen):

```bash
# Terminal 1 — auth-service (autenticação, tokens RSA, refresh rotation)
pnpm --filter @showpass/auth-service dev
# Aguardar: "Nest application successfully started" na porta 3006

# Terminal 2 — api-gateway (JWT, rate-limit, proxy)
pnpm --filter @showpass/api-gateway dev
# Aguardar: "API Gateway rodando na porta 3000"

# Terminal 3 — event-service (eventos, venues, lotes)
pnpm --filter @showpass/event-service dev
# Aguardar: "Event Service rodando na porta 3003"

# Terminal 4 — web (Next.js, Turbopack)
pnpm --filter @showpass/web dev
# Aguardar: "✓ Ready in Xs" em http://localhost:3001
```

Para o dashboard funcionar completamente, adicione:

```bash
# Terminal 5 — booking-service (reservas, Redis locks, OpenTelemetry)
pnpm --filter @showpass/booking-service dev
# Aguardar: "Booking Service rodando na porta 3004"
```

### Verificar que os serviços respondem

```bash
curl -s http://localhost:3000/health | head -c 100   # api-gateway
curl -s http://localhost:3006/health | head -c 100   # auth-service
curl -s http://localhost:3003/health | head -c 100   # event-service
```

---

## 4. Fluxo 1 — Home e tela de login

**Acesse:** `http://localhost:3001`

### O que verificar

**Visual da home:**
- Fundo escuro `#0a0a0f` com pontos azuis pulsantes (nós neurais)
- Logo com anéis `animate-ping` + ícone girando (Sparkles)
- Título "ShowPass" em gradiente branco→azul→violeta
- **Um único botão "Entrar"** (o Header não aparece nessa tela)

**Ao clicar em "Entrar":**
- Um **spinner** aparece cobrindo a tela (LoadingOverlay)
- A navegação para `/login` acontece
- O spinner permanece até o formulário de login renderizar completamente
- ✅ Nenhum "duplo clique" é possível enquanto o spinner está ativo

---

## 5. Fluxo 2 — Cadastro e login como Organizer

### 5.1 Registrar um organizer via API

```bash
curl -s -X POST http://localhost:3000/auth/organizers/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"organizer@showpass.com","password":"Senha@12345","name":"Produtora ShowPass"}' \
  | python3 -m json.tool
```

Resposta esperada:
```json
{
  "accessToken": "eyJhbGciOiJSUzI1NiIs...",
  "expiresIn": 900
}
```

> Guarde o email e senha — serão usados nos próximos passos.

### 5.2 Login pela UI

1. Acesse `http://localhost:3001/login`
2. Confirme o visual "Neural Access":
   - Card glass com borda azul e glow rotativo
   - Logo com anéis pulsantes
   - Inputs com dot indicador pulsante azul
   - Botão gradiente azul→violeta
3. Selecione a aba **Organizador**
4. Entre com `organizer@showpass.com` / `Senha@12345`
5. Clique em **Entrar**

**O que deve acontecer:**
- Botão muda para "Entrando…" com spinner e fica desabilitado
- Overlay escuro cobre a tela inteira (bloqueia cliques duplos)
- O overlay permanece até o `/dashboard` terminar de carregar
- Você é redirecionado para `http://localhost:3001/dashboard`

### 5.3 Verificar o token no browser

Abra DevTools (F12):

| Local | O que verificar |
|---|---|
| **Application → Cookies** | Cookie `refresh_token` com flag `httpOnly` — invisível ao JS (OWASP A07) |
| **Application → Local Storage → `showpass-auth`** | `accessToken`, `expiresAt`, `user.type: "organizer"` |
| **Network** | Request `POST localhost:3000/auth/organizers/login` → 200 |

---

## 6. Fluxo 3 — Painel do Organizador (dashboard)

> **Pré-requisito:** estar logado como organizer (Fluxo 2).

Acesse `http://localhost:3001/dashboard`.

### O que verificar

**Shell do painel:**
- **Sidebar esquerda** (shadcn/ui) com itens: Dashboard, Criar evento, Configurações
- **Topbar** com: botão Trigger da sidebar | "Painel do Organizador" | **toggle de tema** (sol/lua) | **botão Sair**
- Footer da sidebar: avatar com a inicial do email + email completo + botão Sair

**Cards KPI (estilo Horizon UI):**
- 4 cards `rounded-3xl` com sombra suave
- Ícone em badge colorido (indigo/violet/emerald/amber)
- Fundo navbar `#F4F7FE` (light) ou navy `#111c44` (dark)
- Fonte DM Sans
- Banner gradiente azul→violeta no topo com botão "Criar evento"

**Gráfico "Vendas por Dia":**
- `AreaChart` (Recharts) com gradiente indigo/violeta
- Linhas suaves, eixos com `var(--muted-foreground)` — adapta ao tema
- Tooltip com borda e fundo do tema

**Data-table "Top Eventos" (TanStack Table):**
- Headers clicáveis com ícone `ArrowUpDown` para ordenar
- Empty state: "Nenhum evento ainda — crie e publique um evento para ver as vendas aqui."

> **Os cards mostram zeros?** É esperado — ainda não há eventos nem vendas.
> Para popular com dados reais, veja a seção de [criação de evento](#criar-um-evento-via-api) abaixo.

### Criar um evento via API

```bash
# 1. Login como organizer e pegar o token
TOKEN=$(curl -s -X POST http://localhost:3000/auth/organizers/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"organizer@showpass.com","password":"Senha@12345"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")

# 2. Criar um venue (todos os campos são obrigatórios, exceto onde indicado)
VENUE_ID=$(curl -s -X POST http://localhost:3003/venues \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Arena ShowPass",
    "address": "Av. das Nações Unidas, 1000",
    "city": "São Paulo",
    "state": "SP",
    "zipCode": "04578000",
    "latitude": -23.5505,
    "longitude": -46.6333,
    "capacity": 5000
  }' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

echo "VENUE_ID=$VENUE_ID"

# 3. Buscar uma categoria disponível (criadas pelo `make db-seed`)
CATEGORY_ID=$(curl -s http://localhost:3003/categories \
  | python3 -c "import sys,json;cats=json.load(sys.stdin);print(cats[0]['id'])")

echo "CATEGORY_ID=$CATEGORY_ID"

# 4. Criar o evento (o slug é gerado automaticamente a partir do título;
#    note startAt/endAt — sem o "s")
EVENT_ID=$(curl -s -X POST http://localhost:3003/events \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"venueId\": \"$VENUE_ID\",
    \"categoryId\": \"$CATEGORY_ID\",
    \"title\": \"ShowPass Festival 2026\",
    \"description\": \"O maior festival de tecnologia do Brasil\",
    \"startAt\": \"2026-09-15T20:00:00Z\",
    \"endAt\": \"2026-09-15T23:00:00Z\"
  }" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

echo "EVENT_ID=$EVENT_ID"

# 5. Criar um lote de ingressos (saleStartAt/saleEndAt definem a janela de venda)
BATCH_ID=$(curl -s -X POST "http://localhost:3003/events/$EVENT_ID/ticket-batches" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Pista",
    "price": 150.00,
    "totalQuantity": 500,
    "saleStartAt": "2026-06-01T00:00:00Z",
    "saleEndAt": "2026-09-15T20:00:00Z"
  }' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

echo "BATCH_ID=$BATCH_ID"

# 6. Publicar o evento (draft → published)
curl -s -X PATCH "http://localhost:3003/events/$EVENT_ID/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"published"}' | python3 -m json.tool

# 7. Colocar à venda (published → on_sale)
curl -s -X PATCH "http://localhost:3003/events/$EVENT_ID/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"on_sale"}' | python3 -m json.tool
```

Aguarde ~5s e recarregue `http://localhost:3001/dashboard` — os cards mostrarão o evento ativo.

---

## 7. Fluxo 4 — Cadastro e login como Comprador

```bash
# Registrar buyer
curl -s -X POST http://localhost:3000/auth/buyers/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"buyer@showpass.com","password":"Senha@12345"}' \
  | python3 -m json.tool
```

1. Acesse `http://localhost:3001/login`
2. Selecione **Comprador**
3. Entre com `buyer@showpass.com` / `Senha@12345`
4. Você é redirecionado para a **home** (`/`) — buyers não têm painel admin

> Buyers veem a home com os eventos públicos; organizers vão para o dashboard.

---

## 8. Fluxo 5 — Proteção de rotas e auto-redirect

Esses testes validam o **middleware Edge** (sem flash de conteúdo).

### 8.1 Usuário NÃO autenticado tentando acessar rota protegida

```bash
# Sem cookie — deve redirecionar para /login
curl -s -o /dev/null -w '%{http_code} → %{redirect_url}\n' \
  http://localhost:3001/dashboard
# Esperado: 307 → http://localhost:3001/login?as=organizer&redirect=%2Fdashboard
```

No browser: acesse `http://localhost:3001/dashboard` sem estar logado → redirecionado para `/login`.

### 8.2 Organizer logado acessando home ou login

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/organizers/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"organizer@showpass.com","password":"Senha@12345"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")

# Tentar acessar / → deve redirecionar para /dashboard
curl -s -o /dev/null -w '%{http_code} → %{redirect_url}\n' \
  --cookie "access_token=$TOKEN" http://localhost:3001/
# Esperado: 307 → http://localhost:3001/dashboard

# Tentar acessar /login → também redireciona para /dashboard
curl -s -o /dev/null -w '%{http_code} → %{redirect_url}\n' \
  --cookie "access_token=$TOKEN" http://localhost:3001/login
# Esperado: 307 → http://localhost:3001/dashboard
```

No browser: estando logado como organizer, tente ir para `http://localhost:3001/` ou `http://localhost:3001/login` — ambos redirecionam para o dashboard instantaneamente.

### 8.3 Buyer não deve ter acesso ao dashboard

```bash
BUYER_TOKEN=$(curl -s -X POST http://localhost:3000/auth/buyers/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"buyer@showpass.com","password":"Senha@12345"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('accessToken',''))")

curl -s -o /dev/null -w '%{http_code}\n' \
  --cookie "access_token=$BUYER_TOKEN" http://localhost:3001/dashboard
# Esperado: 307 (redirect para /login?as=organizer)
```

---

## 9. Fluxo 6 — Loading spinner (comportamento padrão)

Abra o DevTools → aba **Network** para acompanhar as requests enquanto testa.

### 9.1 Spinner ao navegar para o login

1. Estando na home (`http://localhost:3001/`)
2. Clique em **Entrar**
3. ✅ Spinner (FullScreenLoader) cobre a tela imediatamente
4. ✅ Não é possível clicar de novo no botão
5. ✅ O spinner permanece até o formulário de login estar 100% renderizado

### 9.2 Spinner contínuo durante o login (sem gap)

1. No `/login`, preencha email e senha
2. Clique em **Entrar**
3. ✅ O botão muda para "Entrando…" com spinner e fica desabilitado
4. ✅ O overlay escuro cobre a tela
5. ✅ O overlay NÃO desaparece entre o fim do request e o início do carregamento do dashboard — é contínuo
6. ✅ O spinner some somente quando o `/dashboard` terminou de carregar (dados do servidor incluídos)

### 9.3 Spinner no logout

1. No dashboard, clique em **Sair** (topbar ou sidebar)
2. ✅ Overlay "Saindo…" cobre a tela imediatamente
3. ✅ Botão Sair muda para spinner e fica desabilitado
4. ✅ Spinner some quando a home carregar

### 9.4 Verificar ausência de requisição duplicada

No DevTools → Network:
- Clique rápido duplo em "Entrar" durante o loading
- ✅ Apenas **uma** request `POST /auth/.../login` aparece (não duas)

---

## 10. Fluxo 7 — Tema dark/light

### 10.1 No painel (dashboard)

1. No topbar, clique no **botão de tema** (ícone sol ☀️ ou lua 🌙)
2. ✅ A tela alterna instantaneamente entre dark navy e light
3. ✅ Sidebar, cards KPI, gráfico e tabela adaptam as cores
4. ✅ Recarregue a página — o tema persiste (salvo em `localStorage['showpass-theme']`)
5. ✅ Abra uma nova aba — o tema já começa correto (script no-flash no `<head>`)

### 10.2 Verificar no-flash (sem piscar claro→escuro)

```bash
# Visualizar o script de tema no HTML
curl -s http://localhost:3001/ | grep -o "classList.add\('dark'\)"
# Esperado: classList.add('dark')  ← executado antes da hidratação
```

No browser (F12 → Sources → `(app-pages-router)…layout.tsx`): o script `theme-no-flash` está marcado como `beforeInteractive` — roda antes de qualquer outro JS.

---

## 11. Fluxo 8 — Logout correto (sem 401/404 no Network)

Abra DevTools → **Network** antes de clicar em Sair.

1. Esteja logado como organizer no `/dashboard`
2. Clique em **Sair** (topbar ou sidebar)
3. No Network, filtre por "logout"
4. ✅ `POST localhost:3000/auth/logout` → **204 No Content** (não 401 nem 404)
5. ✅ O header `Authorization: Bearer <token>` está presente na request
6. ✅ O cookie `refresh_token` é revogado no servidor
7. ✅ O cookie `access_token` é expirado no browser (`max-age=0`)

Para buyer:
- O mesmo fluxo → `POST localhost:3000/auth/buyers/logout` → **204**

---

## 12. Fluxo 9 — Observabilidade (métricas + traces + logs)

> **Pré-requisito:** booking-service rodando (Terminal 5 da [seção 3](#3-subir-o-stack-de-desenvolvimento)).

### 12.1 Subir a stack de observabilidade

```bash
# Sobe os 5 containers: otel-collector, prometheus, tempo, loki, grafana
docker compose --profile observability up -d

# Verificar que todos estão de pé (aguardar ~15s)
docker compose --profile observability ps
```

Todos devem mostrar `running`. Verificar no host:

```bash
curl -s http://localhost:9090/-/healthy   # Prometheus → OK
curl -s http://localhost:3100/ready       # Loki → ready
curl -s http://localhost:3200/ready       # Tempo → ready
curl -s http://localhost:3002/api/health  # Grafana → {"database":"ok",...}
```

### 12.2 Gerar telemetria real (booking-service)

```bash
# Usar o simulador de carga (gerador sintético, sem precisar de banco)
cd apps/booking-service
node scripts/observe-sim.mjs
# → "Simulando observabilidade... 8 reservas a cada 800ms"
# Deixar rodar por 1-2 minutos, depois Ctrl+C
```

Ou disparar requests reais (booking-service + event-service rodando):

```bash
BUYER_ID="<seu-buyer-id>"   # do /auth/buyers/register
EVENT_ID="<seu-event-id>"   # do /events
BATCH_ID="<seu-batch-id>"   # do /events/:id/ticket-batches

curl -s -X POST http://localhost:3004/bookings/reservations \
  -H "x-user-id: $BUYER_ID" -H "x-user-type: buyer" \
  -H 'Content-Type: application/json' \
  -d "{\"eventId\":\"$EVENT_ID\",\"items\":[{\"ticketBatchId\":\"$BATCH_ID\",\"quantity\":1}]}"
```

### 12.3 Verificar no Prometheus

```bash
# Deve retornar as séries de negócio do ShowPass
curl -s "http://localhost:9090/api/v1/label/__name__/values" \
  | tr ',' '\n' | grep showpass
```

Esperado:
```
showpass_reservations_conflicts_total
showpass_reservations_duration_milliseconds_bucket
showpass_reservations_duration_milliseconds_count
showpass_reservations_duration_milliseconds_sum
showpass_reservations_total
```

```bash
# Valor atual de reservas criadas
curl -s "http://localhost:9090/api/v1/query" \
  --data-urlencode 'query=sum(showpass_reservations_total)' \
  | python3 -c "import sys,json;r=json.load(sys.stdin)['data']['result'];print(r[0]['value'][1] if r else 'sem dados')"
```

### 12.4 Verificar traces no Tempo

```bash
# Buscar traces do booking-service
curl -s "http://localhost:3200/api/search?tags=service.name%3Dbooking-service&limit=5" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin).get('traces',[])
print(f'{len(d)} traces encontrados')
[print(f'  {t[\"rootTraceName\"]}  ({t[\"traceID\"][:8]}...)') for t in d[:3]]
"
```

Esperado: traces `POST /reservations` com `rootServiceName: booking-service`.

### 12.5 Verificar logs no Loki

```bash
# Buscar logs do booking-service
curl -s -G "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={service_name="booking-service"}' \
  --data-urlencode 'limit=5' \
  | python3 -c "
import sys,json
result=json.load(sys.stdin)['data']['result']
if not result:
    print('sem logs (booking-service não enviou nenhum ainda)')
else:
    streams=result[0].get('values',[])
    print(f'{len(streams)} linhas de log')
    [print(f'  {v[1][:80]}') for v in streams[:3]]
"
```

### 12.6 Grafana — ver tudo junto

1. Acesse `http://localhost:3002` (admin / admin)
2. **Dashboards → pasta ShowPass → "Seat Availability — Real Time"**
   - Cards Reservas/s, Conflitos e Latência P95 aparecem se o simulador rodou
   - Painel "Latência P95 de Reserva" usa `showpass_reservations_duration_milliseconds_bucket` (com sufixo `_milliseconds` — gotcha do exporter Prometheus quando `unit: 'ms'`)
3. **Explore → Datasource: Tempo** → Search → Service Name: `booking-service` → "Run query"
   - Clique num trace → veja a árvore de spans
4. **Explore → Datasource: Loki** → query: `{service_name="booking-service"}`
5. **Alerting → Alert rules → pasta ShowPass** → 3 regras: conflitos, latência P95, pods

### 12.7 Correlação trace ↔ log

No Tempo, abra um trace → clique em qualquer span → **"Logs for this span"**:
- O Grafana abre o Loki filtrado pelo `traceId` daquele trace
- Você vê exatamente os logs daquela request específica

---

## 13. Testes automatizados (CI local)

```bash
# Roda lint (ESLint) + type-check (tsc --noEmit) + audit de segurança
make ci

# Só os testes unitários do booking-service (SeatLockService)
pnpm --filter @showpass/booking-service test

# Verificar cobertura de linhas críticas
pnpm --filter @showpass/booking-service test -- --coverage 2>/dev/null | tail -10
```

Resultado esperado do `make ci`:
```
✓ lint        — 0 errors
✓ type-check  — 16/16 packages sem erro
✓ audit       — 0 high/critical vulnerabilities
```

Resultado esperado dos unit tests:
```
PASS src/modules/locks/seat-lock.service.spec.ts
  SeatLockService
    ✓ deve adquirir todos os locks e retornar success: true
    ✓ deve liberar locks adquiridos quando um falha (compensação all-or-nothing)
    ✓ deve retornar todos os seatIds indisponíveis quando múltiplos falham
Tests: 3 passed
```

---

## 14. Portas e URLs de referência

| Serviço | Porta | URL |
|---|---|---|
| **Frontend (Next.js)** | 3001 | http://localhost:3001 |
| **API Gateway** | 3000 | http://localhost:3000 |
| **Auth Service** | 3006 | http://localhost:3006 |
| **Event Service** | 3003 | http://localhost:3003 |
| **Booking Service** | 3004 | http://localhost:3004 |
| **Payment Service** | 3002 | — |
| **Search Service** | 3005 | — |
| **Kafka UI** | 8080 | http://localhost:8080 |
| **Grafana** | 3002* | http://localhost:3002 |
| **Prometheus** | 9090 | http://localhost:9090 |
| **Loki** | 3100 | http://localhost:3100 |
| **Tempo** | 3200 | http://localhost:3200 |
| **Swagger (gateway)** | 3000 | http://localhost:3000/docs |

> \* Grafana e Payment Service usam a porta 3002 em contextos diferentes:
> o Grafana só sobe com `--profile observability`; o Payment Service sobe
> via `pnpm dev`. Não sobem juntos no fluxo padrão.

### Credenciais de desenvolvimento

| Recurso | Usuário / Email | Senha / Secret |
|---|---|---|
| PostgreSQL | `showpass` | `showpass_dev_secret` |
| Redis | — | `redis_dev_secret` |
| Grafana | `admin` | `admin` |

> **Nunca use estas credenciais em produção.** Elas são defaults do `.env.example`
> para desenvolvimento local.

---

## Troubleshooting

### `EADDRINUSE: listen EADDRS error: port 3004 is already in use`

**Causa:** Uma instância anterior do serviço (ex. booking-service) ainda está rodando na porta.

**Solução rápida:**
```bash
# Encontrar e matar o processo
ss -tlnp | grep :3004                    # mostra o pid
kill -9 <pid>                             # força encerramento

# Ou: matar todos os nodes que possam estar rodando o serviço
pkill -9 -f "booking-service"
```

**Evitar no futuro:** sempre `Ctrl+C` os serviços em dev antes de reiniciar. Se usar
`--watch`, o Node às vezes não derruba cleanly ao receber SIGTERM — nesse caso,
`kill -9` é necessário.

### `Error: connect ECONNREFUSED: gateway/event-service não respondem`

**Causa:** você iniciou o frontend ou uma requisição, mas não subiu o serviço correspondente.

**Solução:**
```bash
# Verificar que todos os serviços responsivos:
curl -s http://localhost:3000/health
curl -s http://localhost:3006/health
curl -s http://localhost:3003/health
curl -s http://localhost:3004/health

# Se algum falhar, iniciar em um novo terminal:
pnpm --filter @showpass/api-gateway dev
pnpm --filter @showpass/auth-service dev
pnpm --filter @showpass/event-service dev
pnpm --filter @showpass/booking-service dev
```

### `Hydration mismatch / Warning: Text content did not match`

**Causa comum (já corrigido no cap-10):** extensões do browser (ex. Kaspersky) injetam
atributos HTML antes da hidratação React.

**Solução:** o código já tem `suppressHydrationWarning` nos inputs (login-form.tsx) —
é safe ignore se a funcionalidade funciona. Não é bug de código.

### `TypeError: Cannot read property 'accessToken' of null`

**Causa:** localStorage está vazio ou a aba abriu em incognito (localStorage bloqueado).

**Solução:**
```bash
# Fazer login normalmente — o estado é sincronizado com localStorage
# Se usar incognito: sair dele (localStorage é inacessível lá)
```

### `Dashboard vazio: cards mostram zeros, tabela está vazia`

**Causa esperada:** ainda não há eventos cadastrados. Os métodos fazem queries ao banco vazio.

**Solução:** seguir a seção [Fluxo 3 — Criar um evento via API](#criar-um-evento-via-api)
para registrar um evento real. O painel atualiza em ~5s (não é real-time no 1º load).

### `Observabilidade: Prometheus/Loki/Tempo não coletam dados`

**Causa 1:** OTEL Collector não está rodando.

```bash
docker compose --profile observability ps | grep otel
# Se não aparecer, subir:
docker compose --profile observability up otel-collector -d
```

**Causa 2:** `OTEL_EXPORTER_OTLP_ENDPOINT` não foi exportado ou está errado.

```bash
# Verificar que a env está setada:
env | grep OTEL_EXPORTER_OTLP_ENDPOINT

# Se vazio, rodar:
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pnpm --filter @showpass/booking-service dev
```

**Causa 3:** Collector está off ou não escuta na porta certa.

```bash
# Verificar que o collector escuta na :4318
docker compose logs otel-collector | grep -iE "listening|error|4318"
```

### `curl retorna 404 em rota que existe`

**Causa 1 — usando porta errada:** você fez `curl localhost:3006/events` (auth-service),
mas `/events` é do event-service (3003).

```bash
# Correto:
curl http://localhost:3003/events
```

**Causa 2 — rota protegida sem Bearer:** a maioria das rotas exige `Authorization: Bearer <token>`.

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/events
```

**Causa 3 — slug vs uuid:** rotas de leitura pública usam slug (ex. `/events/showpass-festival-2026/public`),
rotas de admin usam uuid (ex. `/events/a644d8e5-8c36-4114-9e38-307f777e16e5`).

```bash
# Público (slug):
curl http://localhost:3003/events/showpass-festival-2026/public

# Admin (uuid + Bearer):
curl -H "Authorization: Bearer $TOKEN" http://localhost:3003/events/a644d8e5-8c36-4114-9e38-307f777e16e5
```

### `Logout retorna 401/404`

**Causa:** corrigido em cap-10. Se voltar a dar 401/404:

```bash
# 1. Verificar que o Bearer está sendo enviado
curl -i -X POST http://localhost:3000/auth/logout -H "Authorization: Bearer $TOKEN"
# Deve retornar 204 No Content

# 2. Se retornar 401, o token expirou:
TOKEN=$(curl -s -X POST http://localhost:3000/auth/organizers/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"painel@showpass.com","password":"Senha@12345"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")
curl -X POST http://localhost:3000/auth/logout -H "Authorization: Bearer $TOKEN"
```

### `Muitos processos Node rodando (pnpm --filter ... dev)`

**Limpeza rápida:**
```bash
# Matar todos os Node que rodem pnpm
pkill -9 -f "pnpm.*dev"

# Ou mais cirúrgico (por serviço):
pkill -9 -f "auth-service"
pkill -9 -f "api-gateway"
pkill -9 -f "event-service"
pkill -9 -f "booking-service"
```

---

## Documentação de referência

- **Arquitetura:** [docs/architecture.md](architecture.md)
- **Capítulos anteriores:** [docs/](.)
- **ADRs (decisões arquiteturais):** [docs/decisions/](decisions/) (se houver)
