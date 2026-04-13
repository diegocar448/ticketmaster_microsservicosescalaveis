# Skill: Code Review — ShowPass

Use este checklist ao revisar código gerado ou proposto para o ShowPass.

## Segurança (OWASP)

- [ ] **A01 Broken Access Control:** Toda query passa `organizerId`/`buyerId`? Tenant isolation preservado?
- [ ] **A02 Crypto:** Passwords via bcrypt cost 12? HMAC-SHA256 para QR e webhooks?
- [ ] **A03 Injection:** Usando Prisma parameterized queries? Sem concatenação SQL manual?
- [ ] **A05 Misconfiguration:** `NODE_ENV=production` desabilita stack traces? Helmet configurado?
- [ ] **A07 Auth:** Rate limiting em endpoints de login? JWT expira em 15min? Refresh token rotation?
- [ ] **A10 SSRF/Webhooks:** `stripe.webhooks.constructEvent()` chamado antes de qualquer processamento?

## Padrões do projeto

- [ ] Controllers não importam PrismaService diretamente (usar Repository)
- [ ] Zod 4: usando `z.uuid()`, `z.url()`, `z.email()` (não `z.string().uuid()`)
- [ ] TypeScript 6.0: sem `any` explícito, sem `!` non-null assertion
- [ ] Comentários explicam o PORQUÊ, não o O QUÊ
- [ ] Idioma dos comentários e mensagens: pt-BR
- [ ] Kafka consumer tem idempotência (checar se já processou antes de processar)

## Performance

- [ ] Queries de listagem têm `take`/`limit` (sem retornar tabela inteira)
- [ ] Índices necessários adicionados no schema Prisma
- [ ] Cache-Aside implementado para leituras frequentes no Event Service
- [ ] Disponibilidade de assentos verifica Redis + PostgreSQL (não só um)

## Confiabilidade

- [ ] Redis calls envolvidas em Circuit Breaker?
- [ ] Kafka emit em try/catch com log de falha?
- [ ] Stripe webhook tem idempotência (`if order.status === 'paid' return`)?
- [ ] Lock all-or-nothing: se 1 assento falha, todos os locks são liberados?

## Versões

- [ ] Prisma 7 (não 6)
- [ ] TypeScript 6.0 (não 5.x)
- [ ] Zod 4 (não 3.x)
- [ ] Stripe SDK 22 (não versões anteriores)
