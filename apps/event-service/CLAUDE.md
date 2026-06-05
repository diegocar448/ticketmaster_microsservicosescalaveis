# event-service — Gotchas para Claude

## Responsabilidade única
Gerencia o ciclo de vida de eventos, venues e lotes de ingressos.
É a fonte de verdade para status de evento, capacidade e preço.

---

## Invariantes críticas — NUNCA quebrar

### Máquina de estados (event-status.ts)
O status de um evento só pode seguir transições explicitamente permitidas:
```
draft → published → on_sale → sold_out ↘
                            ↘ cancelled  → (final)
                            ↘ completed  → (final)
sold_out → on_sale  (cancelamentos liberam assentos)
```
`cancelled` e `completed` são estados FINAIS — sem saída.
NUNCA fazer `event.update({ status })` direto no banco sem passar pelo `EventStatusMachine.assertTransition()`.
Se a máquina não permitir, ela lança erro — confie nela.

### Slug único com fallback incremental (events.service.ts)
Slugs são gerados como `titulo-kebab` (limpo e legível).
Em colisão: sufixo `-2`, `-3`... até 1000, depois timestamp como último recurso.
NUNCA voltar a usar `Date.now()` diretamente: gera URLs feias não navegáveis.

### Tenant isolation — organizerId em TODA query
Toda query de leitura/escrita de organizer DEVE incluir `organizerId` no where.
Sem isso, um organizer vê/edita eventos de outro (OWASP A01).
O OrganizerGuard injeta `x-organizer-id` via gateway — sempre extrair do header, nunca do body.

### Cache Redis (Cache-Aside)
TTL varia por status do evento:
- `on_sale`: curto (disponibilidade muda com reservas)
- `published`/`draft`: longo (mudanças infrequentes)

Ao mudar status, o cache do slug antigo DEVE ser invalidado proativamente.
Sem invalidação, compradores veem status desatualizado.

---

## Arquivos de alto risco
- `src/modules/events/event-status.ts` — grafo de transições de status
- `src/modules/events/events.service.ts` — `generateUniqueSlug`, `transitionStatus`
- `src/modules/events/events.repository.ts` — `listPublic` (sem tenant filter — intencional)

## Rota pública vs rota de organizer
```
GET /events/browse          → público (sem auth) — listagem on_sale para buyers
GET /events/:slug/public    → público (sem auth) — página do evento
GET /events/:id/public-meta → público (sem auth) — metadata para booking-service
GET /events                 → organizer only — lista eventos do tenant
POST /events                → organizer only — cria evento
PATCH /events/:id/status    → organizer only — transição de status
```

## Dependências externas
- Redis: cache de leitura de eventos (RedisService do @showpass/redis)
- Kafka: emite EventReplicatedEvent ao publicar/atualizar evento (indexação no search-service)
- Prisma: banco dedicado `showpass_events`
