# api-gateway — Gotchas para Claude

## Responsabilidade única
Único ponto de entrada público da plataforma.
Valida JWT UMA VEZ, enriquece com headers internos e faz proxy.
Os serviços downstream confiam nos headers x-user-id/x-user-type — NÃO revalidam JWT.

---

## Invariantes críticas — NUNCA quebrar

### Ordem dos middlewares (app.module.ts)
```
LoggerMiddleware → JwtAuthMiddleware → ProxyController
```
Logger ANTES do Auth — senão requests rejeitadas não são logadas.
Auth ANTES do Proxy — senão requests não autenticadas chegam aos serviços.

### Headers injetados pelo JWT middleware
`x-user-id`, `x-user-type`, `x-organizer-id` (quando organizer).
Os guards internos (OrganizerGuard, BuyerGuard) dependem EXCLUSIVAMENTE desses headers.
Remover ou renomear quebra TODOS os guards de todos os serviços.

### exclude() do JwtAuthMiddleware
NUNCA usar wildcard amplo como `events/*path` no exclude.
Isso excluiria rotas de organizer (dashboard/stats, CRUD) deixando-as sem headers injetados.
Sempre excluir rotas individuais e específicas.

### Rate limiting — NÃO remover (OWASP A07)
- `global`: 300 req/min por IP
- `auth`: 5 req/min por IP (previne brute force no login)

### Roteamento do ProxyController
`HealthModule` ANTES de `ProxyModule` no app.module.ts.
O ProxyController registra `@All('*')` — captura qualquer path.
Em Express, primeira rota vence: /health precisa estar antes do wildcard.

---

## Rotas públicas atuais (sem JWT)
Ao adicionar nova rota pública, incluir no `exclude()` EM APP.MODULE.TS.

```
POST auth/organizers/register | login | refresh
POST auth/buyers/register    | login
POST auth/refresh
GET  events/browse           (listagem pública)
GET  events/:slug/public     (página do evento)
GET  events/:id/public-meta  (metadata para booking-service)
GET  search/*path            (busca pública)
GET  categories              (filtros públicos)
POST webhooks/stripe         (autenticado via HMAC, não JWT)
```

---

## Arquivos de alto risco
- `src/app.module.ts` — lista de exclusões do JWT + ordem de middlewares
- `src/common/middleware/jwt-auth.middleware.ts` — injeta headers x-user-id/x-user-type
- `src/modules/proxy/proxy.controller.ts` — SERVICE_MAP de rotas → serviços

## SERVICE_MAP (proxy.controller.ts)
```
/auth        → auth-service:3006
/events      → event-service:3003
/venues      → event-service:3003
/categories  → event-service:3003
/bookings    → booking-service:3004
/payments    → payment-service:3002
/search      → search-service:3005
/webhooks    → payment-service:3002
/workers     → worker-service:3007
```
Em produção as URLs vêm de env vars (K8s DNS interno).

---

## Padrão de adição de nova rota pública
1. Adicionar a rota no serviço alvo
2. Adicionar no `exclude()` do JwtAuthMiddleware em `app.module.ts`
3. Se o serviço não está no SERVICE_MAP, adicionar lá também
4. Reiniciar o gateway para pegar as mudanças
