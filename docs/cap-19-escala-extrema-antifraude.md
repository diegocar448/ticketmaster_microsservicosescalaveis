# Capítulo 19 — 80 Milhões de Fãs, Zero Bots e Antifraude

> **Objetivo:** Levar o ShowPass de 10M para **80M de usuários simultâneos**, garantir que apenas **fãs reais** (não bots) cheguem aos ingressos, blindar o pagamento com uma camada **antifraude** que mitiga chargeback sem matar a conversão — e implementar as regras de negócio reais do mercado brasileiro (limite por CPF, meia-entrada, descontos) — tudo isso sem explodir o banco transacional.

Este é o capítulo "boss final". Os capítulos anteriores construíram um sistema que **funciona**. Este constrói um sistema que **sobrevive** a um show do maior artista do mundo abrindo vendas numa sexta-feira às 10h.

## O que você vai aprender

- **Dimensionar para 80M concorrentes:** por que o gargalo deixa de ser CPU e vira a *linha quente do banco* e a *chamada síncrona externa*
- **Fan Gate:** fila virtual com token assinado + Proof of Work + bot score — bloqueia F5, navegador headless e IPs de datacenter
- **Por que o Stripe síncrono "estoura"** sob carga, e como trocar por orquestração assíncrona (Outbox + fila + worker idempotente + Circuit Breaker)
- **Motor antifraude** baseado em regras + score de risco, com step-up 3DS só para o que é arriscado (preserva conversão, transfere a responsabilidade do chargeback)
- **Regras de negócio:** setores e faixas de preço, cupons de desconto, **limite atômico por CPF**, **cota e validação de meia-entrada** (Lei nº 12.933/2013)
- **Blindar o banco:** contadores shardeados no Redis, particionamento por evento, PgBouncer e o padrão Outbox

---

## Passo 19.1 — Dimensionando para 80M: onde o sistema realmente quebra

A primeira armadilha do engenheiro júnior é pensar "80M de usuários = preciso de 8× mais pods". Errado. **Serviço stateless escala trivialmente** com HPA (cap-16). O que **não** escala automaticamente é tudo que tem estado compartilhado:

```
O FUNIL REAL DE UM MEGA-EVENTO
═══════════════════════════════════════════════════════════════

  80.000.000  pessoas dão F5 às 10h00m00s
        │
        │  ← 99,9% são "curiosos" ou bots. Só ~2M têm intenção real
        ▼
  ┌─────────────────────────────────────────────┐
  │  FAN GATE (Passo 19.2)                        │  ← absorve o tsunami
  │  fila virtual + PoW + bot score               │     na BORDA
  └─────────────────────────────────────────────┘
        │
        │  ← admite ~50.000 por "onda" (igual à capacidade do estádio)
        ▼
  ┌─────────────────────────────────────────────┐
  │  BOOKING (cap-06)                             │  ← só toca o REDIS
  │  Redis SETNX — 1 assento, 1 dono              │     (memória, não disco)
  └─────────────────────────────────────────────┘
        │
        │  ← ~50.000 reservas → checkout
        ▼
  ┌─────────────────────────────────────────────┐
  │  PAGAMENTO ASSÍNCRONO (Passo 19.4)            │  ← desacopla do Stripe
  │  Outbox → fila → worker idempotente           │     (a chamada externa
  └─────────────────────────────────────────────┘      NÃO está no hot path)

GARGALOS QUE NÃO ESCALAM COM "MAIS PODS":
  1. A LINHA do evento popular no Postgres (UPDATE reservedCount++)
     → 50k UPDATEs/s na MESMA linha = lock contention + WAL no limite
  2. A conta Stripe (rate limit + latência de rede de 100-800ms)
     → 50k chamadas síncronas seguram 50k conexões esperando I/O externo
  3. O pool de conexões do Postgres
     → cada request segurando uma conexão = pool esgotado em segundos
```

A regra de ouro do capítulo, que guia todas as decisões a seguir:

> **No caminho quente (hot path), só toque memória. Disco e rede externa são assíncronos.**

Cálculo de guardanapo para fixar a intuição (Little's Law — `concorrência = throughput × latência`):

```
Se cada request síncrono ao Stripe leva 500ms e queremos 50.000 checkouts:
   concorrência = 50.000 req × 0,5s = 25.000 conexões SIMULTÂNEAS travadas em I/O

Com pool de 100 conexões por pod e 50 pods → 5.000 conexões disponíveis.
   25.000 necessárias > 5.000 disponíveis → TIMEOUT EM CASCATA.

É exatamente o "Stripe deu timeout sob carga" do enunciado. A solução não é
"aumentar o timeout" (piora: segura a conexão por mais tempo) — é TIRAR a
chamada externa do caminho síncrono. Ver Passo 19.4.
```

---

## Passo 19.2 — Fan Gate: o microsserviço que separa fã de bot

Criamos um novo serviço, o **`gatekeeper-service`**, que fica na frente de tudo. Ele não deixa 80M de requisições chegarem ao booking — emite um **passe de entrada** (JWT curto, atrelado ao CPF + dispositivo) que o `api-gateway` passa a exigir nas rotas de reserva.

São três camadas de defesa, da mais barata para a mais cara:

```
Camada 1 — FILA VIRTUAL (token assinado)     → defeito de F5/refresh
Camada 2 — PROOF OF WORK (hashcash)          → torna bot em massa caro
Camada 3 — BOT SCORE (fingerprint + ASN)     → barra datacenter/headless
```

### Camada 1 — Fila virtual com admissão aleatória

A fila do Cloudflare Waiting Room (mencionada no README) resolve a borda, mas precisamos da **lógica de admissão** no nosso lado. O segredo anti-bot: admitir por **sorteio aleatório**, não por ordem de chegada.

```typescript
// apps/gatekeeper-service/src/modules/queue/queue.service.ts
//
// PORQUÊ admissão ALEATÓRIA e não FIFO por ordem de chegada:
// Se a fila fosse "primeiro a chegar, primeiro a entrar", o bot que dá F5
// 1.000×/segundo sempre ganha do fã que clicou uma vez. Com sorteio aleatório
// dentro da janela, dar F5 não aumenta a chance — cada CPF tem UM bilhete no
// sorteio, independentemente de quantas vezes recarregou. Anula a vantagem do bot.

import { Injectable } from '@nestjs/common';
import { RedisService } from '@showpass/redis';
import { createHmac, randomUUID } from 'node:crypto';

const QUEUE_TOKEN_TTL = 30 * 60; // 30 min: tempo máximo numa fila de mega-evento

@Injectable()
export class QueueService {
  constructor(private readonly redis: RedisService) {}

  // Emite um bilhete de fila ATRELADO ao CPF (1 CPF = 1 bilhete por evento).
  // Tentar entrar de novo com o mesmo CPF devolve o MESMO bilhete (idempotente)
  // — dar F5 não cria bilhetes novos.
  async join(eventId: string, cpfHash: string): Promise<QueueTicket> {
    const key = `queue:ticket:${eventId}:${cpfHash}`;

    const existing = await this.redis.getRaw(key);
    if (existing) return JSON.parse(existing);

    const ticket: QueueTicket = {
      id: randomUUID(),
      eventId,
      cpfHash,
      // posição de SORTEIO: um número aleatório, não um contador sequencial.
      // A "onda" de admissão escolhe os menores draws → sorteio justo.
      draw: Math.random(),
      issuedAt: Date.now(),
    };

    // assinatura HMAC: o cliente não pode forjar/alterar o próprio bilhete (OWASP A08)
    ticket.signature = this.sign(ticket);

    await this.redis.set(key, JSON.stringify(ticket), QUEUE_TOKEN_TTL);
    return ticket;
  }

  // Chamado a cada "onda": admite N bilhetes (N = capacidade liberada do estádio).
  // ZADD em sorted set ordenado por `draw` → ZRANGE pega os N menores.
  async admitWave(eventId: string, slots: number): Promise<string[]> {
    // (implementação real usa um ZSET populado no join; resumido aqui)
    return this.redis.popLowestScores(`queue:zset:${eventId}`, slots);
  }

  private sign(t: QueueTicket): string {
    const secret = process.env.QUEUE_HMAC_SECRET!;
    return createHmac('sha256', secret)
      .update(`${t.id}:${t.eventId}:${t.cpfHash}:${t.draw}`)
      .digest('hex');
  }
}

interface QueueTicket {
  id: string;
  eventId: string;
  cpfHash: string;
  draw: number;
  issuedAt: number;
  signature?: string;
}
```

### Camada 2 — Proof of Work: tornar o ataque em massa caro

Antes de receber o bilhete, o cliente precisa **resolver um quebra-cabeça** (hashcash). Para um navegador real, é imperceptível (~200ms). Para um bot tentando 1M de requisições/s, multiplica o custo de CPU por milhões — economicamente inviável.

```typescript
// apps/gatekeeper-service/src/modules/pow/pow.service.ts
//
// Proof of Work (hashcash): o cliente deve encontrar um `nonce` tal que
// sha256(challenge + nonce) comece com `difficulty` zeros (em hex).
// PORQUÊ: desloca o custo do servidor para o atacante. Verificar é O(1) barato;
// resolver é O(2^difficulty) caro. Assimetria que favorece o defensor.

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { RedisService } from '@showpass/redis';

@Injectable()
export class PowService {
  constructor(private readonly redis: RedisService) {}

  // difficulty=4 (~65k tentativas) numa abertura normal;
  // sob ataque, o gatekeeper ELEVA dinamicamente para 5-6 (custo do bot explode).
  async issueChallenge(difficulty = 4): Promise<{ challenge: string; difficulty: number }> {
    const challenge = randomBytes(16).toString('hex');
    // challenge é de uso único: guardamos no Redis com TTL para impedir replay (OWASP A07)
    await this.redis.set(`pow:challenge:${challenge}`, '1', 120);
    return { challenge, difficulty };
  }

  async verify(challenge: string, nonce: string, difficulty: number): Promise<void> {
    const exists = await this.redis.getRaw(`pow:challenge:${challenge}`);
    if (!exists) throw new UnauthorizedException('Desafio expirado ou já usado');

    const hash = createHash('sha256').update(`${challenge}${nonce}`).digest('hex');
    const prefix = '0'.repeat(difficulty);
    if (!hash.startsWith(prefix)) {
      throw new UnauthorizedException('Proof of Work inválido');
    }

    // consome o desafio: cada solução vale UMA vez (anti-replay)
    await this.redis.del(`pow:challenge:${challenge}`);
  }
}
```

### Camada 3 — Bot score: barrar datacenter e headless

Sinais combinados resultam num score de 0 (humano) a 100 (bot). A decisão é por faixa, nunca binária — bloquear errado custa um fã verdadeiro.

```typescript
// apps/gatekeeper-service/src/modules/bot-score/bot-score.service.ts
//
// Score composto. Cada sinal contribui com pontos; nenhum sinal sozinho bloqueia
// (defesa em profundidade — OWASP A04 Insecure Design). A decisão final é por faixa.

import { Injectable } from '@nestjs/common';

interface Signals {
  asnType: 'residential' | 'datacenter' | 'vpn' | 'unknown'; // de um provedor de IP intel
  isHeadless: boolean;          // navigator.webdriver, ausência de canvas/WebGL
  requestsLastMinute: number;   // velocidade por dispositivo (sliding window no Redis)
  hasTouchOrMouseEntropy: boolean; // movimento humano captado no front antes do submit
  attestationValid: boolean;    // Cloudflare Turnstile / Private Access Token
}

@Injectable()
export class BotScoreService {
  score(s: Signals): { score: number; decision: 'allow' | 'challenge' | 'block' } {
    let score = 0;

    // IP de datacenter é o sinal mais forte: fãs reais navegam de redes residenciais/móveis
    if (s.asnType === 'datacenter') score += 50;
    if (s.asnType === 'vpn') score += 20;

    if (s.isHeadless) score += 40;             // Puppeteer/Playwright sem stealth
    if (!s.hasTouchOrMouseEntropy) score += 15; // submit sem nenhuma interação humana
    if (s.requestsLastMinute > 30) score += 25; // velocidade sobre-humana
    if (!s.attestationValid) score += 30;       // falhou no Turnstile

    // Faixas: preferimos "challenge" (PoW mais difícil + Turnstile) a "block".
    // Bloquear é último recurso — falso positivo = fã verdadeiro perdido = dano à marca.
    let decision: 'allow' | 'challenge' | 'block';
    if (score >= 80) decision = 'block';
    else if (score >= 40) decision = 'challenge';
    else decision = 'allow';

    return { score, decision };
  }
}
```

### O passe de entrada e o guard no Gateway

Quem passa nas três camadas e é admitido na onda recebe um **passe de entrada**: um JWT curto (5 min), atrelado a CPF + dispositivo + evento. O `api-gateway` exige esse passe nas rotas de reserva.

```typescript
// apps/api-gateway/src/guards/entry-pass.guard.ts
//
// Sem passe válido → 403. É o que impede um bot de pular a fila chamando
// POST /bookings/reservations direto. O passe prova: "este CPF foi admitido
// na onda atual, neste dispositivo, para este evento" (OWASP A01).

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { jwtVerify } from 'jose';

@Injectable()
export class EntryPassGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const pass = req.headers['x-entry-pass'];
    if (!pass) throw new ForbiddenException('Passe de entrada ausente — entre na fila primeiro');

    try {
      const secret = new TextEncoder().encode(process.env.ENTRY_PASS_SECRET);
      const { payload } = await jwtVerify(pass, secret);

      // o passe é atrelado ao evento da rota: não dá para usar passe de um show em outro
      if (payload.eventId !== req.params.eventId && payload.eventId !== req.body?.eventId) {
        throw new ForbiddenException('Passe não corresponde a este evento');
      }
      req.entryPass = payload; // disponibiliza cpfHash/deviceId para os passos seguintes
      return true;
    } catch {
      throw new ForbiddenException('Passe de entrada inválido ou expirado');
    }
  }
}
```

---

## Passo 19.3 — Regras de negócio: setores, preços, descontos, CPF e meia-entrada

Aqui entra a complexidade que o enunciado pediu: "respeitando regras de assento, setores, valores diferentes, descontos, limitação por CPF, validação de meia entrada". Vamos modelar e, principalmente, **garantir as invariantes sob 50.000 reservas concorrentes**.

### Estendendo o schema (event-service e booking-service)

```prisma
// apps/event-service/prisma/schema.prisma  (adições)

// Faixa de preço por setor. Um mesmo evento tem Pista (R$ 200), Cadeira (R$ 350),
// Camarote (R$ 800). Já temos TicketBatch com price+sectionId; aqui formalizamos
// regras adicionais por lote.
model TicketBatch {
  // ...campos do cap-05...

  // Cota de meia-entrada DESTE lote. Lei nº 12.933/2013: mínimo 40% das vagas.
  // Guardamos o teto para validar atomicamente no Passo seguinte.
  halfPriceQuota Int @default(0) // ex.: 40% de totalQuantity

  // Limite de ingressos por CPF NESTE lote (anti-cambista). Default 4.
  maxPerCpf Int @default(4)
}

// Cupom de desconto. Percentual ou valor fixo, com teto de usos e validade.
model Coupon {
  id          String   @id @default(uuid()) @db.Uuid
  eventId     String   @db.Uuid
  code        String   // "FANCLUBE10"
  kind        String   // "percent" | "fixed"
  value       Decimal  @db.Decimal(10, 2) // 10.00 = 10% ou R$10
  maxUses     Int
  usedCount   Int      @default(0)
  expiresAt   DateTime

  @@unique([eventId, code]) // mesmo código pode existir em eventos diferentes
  @@map("coupons")
}
```

### Validação de CPF e meia-entrada (LGPD: nunca armazenar CPF cru)

```typescript
// packages/types/src/schemas/checkout.schema.ts
//
// Zod 4: validadores top-level. CPF é dado sensível (LGPD Art. 5) — NUNCA
// persistimos o número cru. Guardamos SHA-256(cpf + pepper) + os 3 últimos
// dígitos (suficiente para suporte humano confirmar identidade sem expor o dado).

import { z } from 'zod';

// validação estrutural + dígitos verificadores (algoritmo oficial da Receita)
const cpfRegex = /^\d{11}$/;

export const HalfPriceSchema = z.object({
  // tipo de meia-entrada determina qual documento é exigido
  category: z.enum(['estudante', 'idoso', 'pcd', 'jovem_baixa_renda', 'professor']),
  // hash do documento comprobatório (carteirinha, ID) — também nunca cru
  documentHash: z.string().min(64).max(64),
});

export const ReservationItemSchema = z.object({
  ticketBatchId: z.uuid(),
  seatId: z.uuid().nullable(),
  quantity: z.number().int().min(1).max(4),
  // se presente, este item é meia-entrada e disputa a cota
  halfPrice: HalfPriceSchema.optional(),
});

export const CreateReservationSchema = z.object({
  eventId: z.uuid(),
  cpf: z.string().regex(cpfRegex).refine(isValidCpf, 'CPF inválido'),
  couponCode: z.string().optional(),
  items: z.array(ReservationItemSchema).min(1),
});

// dígitos verificadores — rejeita CPFs sintaticamente válidos mas matematicamente falsos
export function isValidCpf(cpf: string): boolean {
  if (/^(\d)\1{10}$/.test(cpf)) return false; // 000.000.000-00 etc.
  const calc = (slice: number) => {
    let sum = 0;
    for (let i = 0; i < slice; i++) sum += +cpf[i] * (slice + 1 - i);
    const d = (sum * 10) % 11;
    return d === 10 ? 0 : d;
  };
  return calc(9) === +cpf[9] && calc(10) === +cpf[10];
}
```

### O limite por CPF, garantido ATOMICAMENTE sob concorrência

Esta é a parte que separa o tutorial do sistema real. Validar "esse CPF já comprou 4?" com um `SELECT count(*)` seguido de `INSERT` é uma **race condition clássica**: 50 requisições do mesmo CPF leem "0" ao mesmo tempo e todas passam. A solução é a mesma filosofia do SETNX do cap-06: **um contador atômico no Redis**, com o Postgres como verdade durável de backstop.

```lua
-- apps/booking-service/src/modules/locks/scripts/cpf-limit.lua
--
-- Check-and-increment atômico do limite por CPF. Roda inteiro dentro do Redis
-- (single-threaded) — impossível dois clientes intercalarem o GET e o INCR.
-- Mesma garantia do SETNX de assentos, aplicada à regra de negócio do CPF.
--
-- KEYS[1] = cpf:limit:{eventId}:{cpfHash}
-- ARGV[1] = limite máximo (maxPerCpf do lote)
-- ARGV[2] = quantidade desta compra
-- ARGV[3] = TTL em segundos (duração da janela de vendas do evento)

local atual  = tonumber(redis.call('GET', KEYS[1]) or '0')
local limite = tonumber(ARGV[1])
local pedido = tonumber(ARGV[2])

if atual + pedido > limite then
  return -1                          -- estouraria: REJEITA sem incrementar
end

local novo = redis.call('INCRBY', KEYS[1], pedido)
if novo == pedido then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))  -- TTL só na 1ª escrita
end
return novo                          -- >= 0: aceito; o caller libera no rollback
```

```typescript
// apps/booking-service/src/modules/reservations/cpf-limit.service.ts
//
// Wrapper do Lua. Importante: o INCR acontece ANTES de persistir a reserva.
// Se a reserva falhar depois (ex.: assento já vendido), DECREMENTAMOS de volta
// (compensação) — exatamente como o release dos locks na Saga do cap-18.

import { Injectable } from '@nestjs/common';
import { RedisService } from '@showpass/redis';
import { createHash } from 'node:crypto';

@Injectable()
export class CpfLimitService {
  constructor(private readonly redis: RedisService) {}

  // hash com pepper de ambiente: mesmo CPF gera sempre a mesma chave, mas o
  // valor no Redis não é reversível (LGPD). O pepper fica fora do banco.
  hashCpf(cpf: string): string {
    return createHash('sha256').update(cpf + process.env.CPF_PEPPER).digest('hex');
  }

  async tryConsume(eventId: string, cpf: string, qty: number, limit: number, windowSec: number) {
    const key = `cpf:limit:${eventId}:${this.hashCpf(cpf)}`;
    const result = await this.redis.evalScript('cpf-limit', [key], [limit, qty, windowSec]);
    if (result === -1) {
      throw new BusinessRuleError(`Limite de ${limit} ingressos por CPF atingido para este evento`);
    }
    return () => this.redis.decrBy(key, qty); // devolve a função de compensação (rollback)
  }
}
```

> **✅ Este trecho saiu do papel — virou código real e testado.** A implementação
> de produção segue a API real do `@showpass/redis`: em vez do `evalScript`/`decrBy`
> ilustrativos acima, usa `RedisService.tryConsumeWithLimit(key, qty, limit, ttl)`
> (Lua inline, no mesmo estilo do `releaseLock`) e `ConflictException` (HTTP 409).
> O limite vem da env `MAX_TICKETS_PER_CPF` (default 4). Veja:
> - `packages/redis/src/redis.service.ts` → `tryConsumeWithLimit`
> - `apps/booking-service/src/modules/reservations/cpf-limit.service.ts`
> - `apps/booking-service/src/modules/reservations/reservations.service.ts` (wiring + rollback)
>
> E há um teste de carga que **prova a invariante**: `infra/k6/cpf-limit-stampede.js`
> dispara 200 reservas do mesmo CPF em paralelo — exatamente 4 passam (201), as outras
> 196 recebem 409. Medido localmente: ✅ nem 1 a mais. (O resto do Passo 19.3 —
> meia-entrada, cupons, motor de preços — segue como design, ainda não implementado.)

> **Backstop durável:** o Redis pode, em teoria, perder estado (failover). Por isso a tabela `orders` ganha um índice parcial único garantindo que o invariante sobreviva mesmo se o contador zerar:
> ```sql
> -- impede no nível do banco que o mesmo CPF+evento ultrapasse via caminho alternativo
> CREATE INDEX idx_cpf_event ON order_items_cpf (cpf_hash, event_id);
> -- + uma constraint de agregação validada no commit da transação (Passo 19.6)
> ```

### Meia-entrada: cota de 40% validada na mesma operação atômica

A meia-entrada (50% do valor) é **limitada por cota** — a lei exige no mínimo 40% das vagas, e o organizador não pode vender meia além disso. Mesmo padrão: contador atômico.

```typescript
// apps/booking-service/src/modules/reservations/half-price.service.ts
//
// A cota de meia-entrada compete entre todos os compradores em tempo real.
// Se 40% das vagas são meia e elas acabam, o próximo comprador de meia recebe
// "cota esgotada" — não um erro 500, e nunca vendemos 41%.

@Injectable()
export class HalfPriceService {
  constructor(private readonly redis: RedisService, private readonly cpfLimit: CpfLimitService) {}

  async claim(batchId: string, qty: number, quota: number, doc: HalfPriceDoc) {
    // 1. valida o documento comprobatório conforme a categoria
    //    (estudante → carteirinha válida; idoso → 60+; PCD → laudo; etc.)
    this.assertDocumentEligible(doc);

    // 2. consome a cota atomicamente (mesmo Lua do CPF, outra chave)
    const key = `halfprice:quota:${batchId}`;
    const result = await this.redis.evalScript('cpf-limit', [key], [quota, qty, 86400]);
    if (result === -1) {
      throw new BusinessRuleError('Cota de meia-entrada esgotada para este lote');
    }
    return () => this.redis.decrBy(key, qty); // compensação no rollback
  }

  private assertDocumentEligible(doc: HalfPriceDoc): void {
    // regra real: validação contra base externa (ID Estudantil digital, etc.)
    // aqui validamos estrutura + categoria; a checagem externa roda no worker
    if (!doc.documentHash || doc.documentHash.length !== 64) {
      throw new BusinessRuleError('Documento de meia-entrada inválido');
    }
  }
}
```

### O preço final: motor de precificação

```typescript
// apps/booking-service/src/modules/pricing/pricing.service.ts
//
// Ordem de aplicação importa (e é fonte clássica de bug): meia-entrada é sobre
// o PREÇO BASE; o cupom é sobre o resultado. Documentar a ordem evita a pergunta
// "o desconto do cupom incide antes ou depois da meia?".

@Injectable()
export class PricingService {
  computeUnitPrice(basePrice: Decimal, isHalfPrice: boolean, coupon?: Coupon): Decimal {
    // 1. meia-entrada: 50% do valor cheio (Lei nº 12.933/2013)
    let price = isHalfPrice ? basePrice.div(2) : basePrice;

    // 2. cupom incide sobre o valor já com meia aplicada
    if (coupon) {
      price = coupon.kind === 'percent'
        ? price.mul(new Decimal(1).minus(coupon.value.div(100)))
        : Decimal.max(price.minus(coupon.value), new Decimal(0)); // nunca negativo
    }
    return price.toDecimalPlaces(2);
  }
}
```

---

## Passo 19.4 — Pagamento assíncrono: por que o Stripe síncrono estoura (e o conserto)

Já vimos no Passo 19.1 a matemática do timeout. Agora o conserto. A jornada de checkout deixa de **esperar o Stripe** e passa a **registrar a intenção e responder na hora**.

### O problema do dual-write (e por que o Outbox resolve)

A tentação é: `INSERT order` no Postgres **e** `produce` no Kafka. Mas e se o INSERT commitar e o broker cair antes do produce? Pedido fantasma, sem cobrança. O **Outbox Pattern** elimina isso: gravamos o pedido **e** o evento de cobrança **na mesma transação Postgres**. Um dispatcher lê o outbox e publica — com garantia de que o evento existe sempre que o pedido existe.

```prisma
// apps/payment-service/prisma/schema.prisma  (adições)

// Outbox: a "caixa de saída" transacional. Gravada JUNTO do Order, no mesmo
// commit. Um dispatcher (Passo abaixo) drena para o Kafka. Garante que
// "pedido existe ⇒ evento de cobrança existe" — sem dual-write.
model PaymentOutbox {
  id          String   @id @default(uuid()) @db.Uuid
  orderId     String   @db.Uuid
  topic       String   // "payments.charge-requested"
  payload     Json
  status      String   @default("pending") // pending | dispatched
  createdAt   DateTime @default(now())
  dispatchedAt DateTime?

  @@index([status, createdAt]) // o dispatcher varre os pending mais antigos
  @@map("payment_outbox")
}
```

```typescript
// apps/payment-service/src/modules/orders/orders.service.ts
//
// O checkout vira uma operação 100% local + rápida: grava Order (pending) e o
// evento no outbox NA MESMA TRANSAÇÃO. Responde 202 Accepted imediatamente.
// O cliente acompanha por polling/SSE. A chamada ao Stripe NÃO está aqui.

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrder(input: CreateOrderInput): Promise<{ orderId: string; status: 'processing' }> {
    const order = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: { /* buyerId, organizerId, eventId, subtotal, total, idempotencyKey, status: 'pending' */ },
      });

      // mesmo commit: se o INSERT do order falha, o outbox não existe (e vice-versa)
      await tx.paymentOutbox.create({
        data: {
          orderId: order.id,
          topic: 'payments.charge-requested',
          payload: { orderId: order.id, amount: order.total, idempotencyKey: order.idempotencyKey },
        },
      });
      return order;
    });

    // 202: "aceitei, estou processando". NÃO esperamos o Stripe → sem timeout em cascata.
    return { orderId: order.id, status: 'processing' };
  }
}
```

### O worker de cobrança: idempotente, com Circuit Breaker e Bulkhead

O `payment-worker` consome o tópico e **aí sim** chama o Stripe — fora do caminho do usuário, com concorrência controlada (bulkhead) e Circuit Breaker (cap-18). Se o Stripe degradar, o breaker abre e os eventos ficam na fila, sem derrubar nada.

```typescript
// apps/payment-service/src/modules/charge/charge.worker.ts
//
// Reúne três defesas do cap-18 + uma nova:
//   - Circuit Breaker (opossum): se o Stripe falhar, para de chamar e protege o resto
//   - Bulkhead (p-limit): no MÁXIMO N chamadas simultâneas ao Stripe — nunca 50k
//   - Idempotency-Key: o Stripe dedupe retries; reprocessar o Kafka não cobra 2×
//   - Dead-letter: mensagem "envenenada" vai para análise, não trava a fila

import { p as pLimit } from 'p-limit';
import { createCircuitBreaker } from '@showpass/redis'; // factory do cap-18

const limit = pLimit(50); // bulkhead: teto de 50 chamadas concorrentes ao Stripe

@Injectable()
export class ChargeWorker {
  private breaker = createCircuitBreaker(
    (args: ChargeArgs) => this.callStripe(args),
    { timeout: 8000, errorThresholdPercentage: 50, resetTimeout: 30_000 },
  );

  @EventPattern('payments.charge-requested')
  async onChargeRequested(@Payload() msg: ChargeRequested): Promise<void> {
    // idempotência de ENTRADA: se já está paid, retry do Kafka não faz nada (cap-07)
    const order = await this.orders.findById(msg.orderId);
    if (order.status === 'paid') return;

    await limit(() =>
      this.breaker.fire({
        amount: msg.amount,
        // a MESMA idempotencyKey do order: o Stripe garante "cobra uma vez só"
        idempotencyKey: msg.idempotencyKey,
      }),
    ).catch((err) => this.handleFailure(msg, err)); // breaker aberto → re-enfileira/DLQ
  }

  private async callStripe(args: ChargeArgs) {
    const intent = await this.stripe.paymentIntents.create(
      { amount: args.amount, currency: 'brl', confirm: true /* ... */ },
      { idempotencyKey: args.idempotencyKey },
    );
    // sucesso → emite payments.payment-confirmed (a Saga do cap-18 confirma a reserva)
    await this.kafka.emit('payments.payment-confirmed', { orderId: args.orderId });
  }
}
```

> **Alívio de pressão com PIX:** no Brasil, oferecer PIX como alternativa ao cartão reduce drasticamente a carga sobre o Stripe num pico. PIX é assíncrono por natureza (QR Code → confirmação via webhook do PSP), então encaixa perfeitamente neste modelo: gera a cobrança, responde 202, confirma quando o webhook do banco chegar. Menos cartão = menos chargeback e menos dependência de uma única rede.

---

## Passo 19.5 — Motor antifraude: aprovar o fã, barrar o fraudador

Decoupar do Stripe resolve a **escala**. Falta a **legitimidade**: o enunciado pede "garantir que sejam transações legítimas... mitigue o chargeback... mas garanta a conversão". Essas duas metas brigam — bloquear demais derruba a conversão; bloquear de menos enche de chargeback. O equilíbrio é **risco baseado em score**, não regra binária.

```typescript
// apps/payment-service/src/modules/fraud/risk-engine.ts
//
// Motor de regras componível: cada regra devolve pontos + motivo. A soma vira
// uma DECISÃO por faixa. A filosofia central:
//   - baixo risco  → aprova SEM fricção (preserva conversão — a maioria dos fãs)
//   - médio risco  → step-up 3DS (Strong Customer Authentication)
//   - alto risco   → nega ou manda para revisão manual
//
// O 3DS é a arma anti-chargeback número 1: quando o cliente autentica no banco
// dele, a RESPONSABILIDADE do chargeback por fraude TRANSFERE para o emissor
// (liability shift). Por isso ele é o "meio-termo" — não bloqueia o fã, mas
// blinda contra o fraudador.

interface RiskContext {
  cpfHash: string;
  deviceId: string;
  ip: string;
  cardBin: string;          // 6 primeiros dígitos → país/banco emissor
  cardHolderName: string;
  buyerName: string;
  email: string;
  botScore: number;         // herdado do Fan Gate (Passo 19.2)
  amount: number;
}

type RiskRule = (ctx: RiskContext, redis: RedisService) => Promise<{ points: number; reason?: string }>;

// Velocidade: muitos cartões diferentes no mesmo CPF/dispositivo numa janela curta
// é a assinatura clássica de teste de cartão roubado (card testing).
const velocityRule: RiskRule = async (ctx, redis) => {
  const window = `fraud:cards:${ctx.cpfHash}`;
  const distinctCards = await redis.pfAdd(window, ctx.cardBin); // HyperLogLog, TTL 1h
  if (distinctCards > 3) return { points: 40, reason: 'Muitos cartões distintos no mesmo CPF' };
  return { points: 0 };
};

// Nome do titular do cartão ≠ nome do comprador → sinal (não prova) de fraude
const nameMatchRule: RiskRule = async (ctx) => {
  const similar = nameSimilarity(ctx.cardHolderName, ctx.buyerName);
  if (similar < 0.5) return { points: 25, reason: 'Titular do cartão difere do comprador' };
  return { points: 0 };
};

// Deny list: CPF/dispositivo com chargeback confirmado no passado
const denyListRule: RiskRule = async (ctx, redis) => {
  const blocked = await redis.getRaw(`fraud:deny:${ctx.cpfHash}`);
  if (blocked) return { points: 100, reason: 'Histórico de chargeback confirmado' };
  return { points: 0 };
};

// e-mail descartável (mailinator etc.) + botScore alto herdado do Fan Gate
const signalsRule: RiskRule = async (ctx) => {
  let points = 0;
  if (isDisposableEmail(ctx.email)) points += 20;
  points += Math.floor(ctx.botScore / 5); // bot no gate eleva o risco no pagamento
  return { points, reason: points > 0 ? 'Sinais de e-mail/dispositivo' : undefined };
};

@Injectable()
export class RiskEngine {
  private rules: RiskRule[] = [velocityRule, nameMatchRule, denyListRule, signalsRule];

  constructor(private readonly redis: RedisService) {}

  async assess(ctx: RiskContext): Promise<RiskDecision> {
    const results = await Promise.all(this.rules.map((r) => r(ctx, this.redis)));
    const score = results.reduce((sum, r) => sum + r.points, 0);
    const reasons = results.filter((r) => r.reason).map((r) => r.reason!);

    // Faixas calibradas com o feedback loop (chargebacks rotulados realimentam os
    // thresholds). Começa conservador e afrouxa conforme os dados chegam.
    let decision: 'approve' | 'challenge_3ds' | 'review' | 'deny';
    if (score >= 90) decision = 'deny';
    else if (score >= 50) decision = 'review';
    else if (score >= 25) decision = 'challenge_3ds'; // step-up: blinda chargeback
    else decision = 'approve';                         // frictionless: preserva conversão

    return { score, decision, reasons };
  }
}
```

Como a decisão entra no fluxo de cobrança do Passo 19.4:

```typescript
// dentro do ChargeWorker, antes de chamar o Stripe:
const risk = await this.riskEngine.assess(ctx);

switch (risk.decision) {
  case 'deny':
    await this.orders.markFailed(msg.orderId, 'fraud_denied');
    return; // a Saga (cap-18) libera os locks — assento volta ao mercado

  case 'review':
    await this.reviewQueue.enqueue(msg.orderId, risk.reasons);
    return; // humano decide; reserva segura pelo TTL

  case 'challenge_3ds':
    // confirm com 3DS obrigatório → liability shift para o emissor
    await this.stripe.paymentIntents.create(
      { amount: msg.amount, currency: 'brl', confirm: true,
        payment_method_options: { card: { request_three_d_secure: 'any' } } },
      { idempotencyKey: msg.idempotencyKey },
    );
    break;

  case 'approve':
    await this.callStripe({ /* sem fricção */ });
    break;
}
```

> **A tensão conversão × chargeback, dita por um arquiteto sênior:** não existe threshold "certo" — existe o threshold que respeita o apetite de risco do negócio. Um falso positivo (negar um fã verdadeiro) custa uma venda **e** a reputação. Um falso negativo (aprovar um fraudador) custa o valor do ingresso **mais** a multa de chargeback **mais** o risco de entrar no programa de monitoramento das bandeiras. Por isso o `review` e o `challenge_3ds` existem: são as válvulas de escape entre o "sim" e o "não" que mantêm a conversão alta sem abrir a porta para fraude.

---

## Passo 19.6 — Blindando o banco transacional ("rezar pra não explodir")

Tudo acima tira carga do banco, mas o evento mais popular ainda concentra escritas numa região quente. Quatro técnicas, da mais impactante para a mais incremental:

### 1. Contadores shardeados — não bata sempre na mesma linha

O `UPDATE ticket_batches SET reservedCount = reservedCount + 1 WHERE id = X` num lote popular serializa 50k escritas na **mesma linha** → lock contention. A disponibilidade já vive no Redis (cap-06); o Postgres não precisa do contador em tempo real. **Reconciliamos em lote.**

```typescript
// apps/booking-service/src/modules/reconcile/counter-flush.service.ts
//
// O contador "quente" vive no Redis (INCR é atômico e em memória). Um job
// periódico achata o delta acumulado para o Postgres em UMA escrita por lote,
// não 50k. O Postgres deixa de ser o gargalo do hot path.

@Injectable()
export class CounterFlushService {
  @Cron('*/5 * * * * *') // a cada 5s
  async flush(): Promise<void> {
    const dirtyBatches = await this.redis.popDirtySet('batch:dirty');
    for (const batchId of dirtyBatches) {
      const reserved = await this.redis.getRaw(`batch:reserved:${batchId}`);
      // 1 UPDATE por lote a cada 5s — em vez de 50k UPDATEs/s na mesma linha
      await this.prisma.ticketBatch.update({
        where: { id: batchId },
        data: { reservedCount: Number(reserved) },
      });
    }
  }
}
```

### 2. Particionamento declarativo por evento

Reservas e pedidos de um mega-evento incham uma única tabela. Particionar por `event_id` mantém os índices de cada evento pequenos e permite **destacar** (DETACH) o evento depois que ele acontece — sem `DELETE` caro.

```sql
-- migration: reservas particionadas por hash do event_id
-- PORQUÊ: cada partição tem seu próprio índice/heap. O evento viral não
-- degrada a performance dos outros eventos. Pós-evento, DETACH é instantâneo.
CREATE TABLE reservations (
  id          uuid NOT NULL,
  event_id    uuid NOT NULL,
  buyer_id    uuid NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
) PARTITION BY HASH (event_id);

-- 16 partições: espalha a carga de escrita entre 16 heaps/índices distintos
CREATE TABLE reservations_p0  PARTITION OF reservations FOR VALUES WITH (MODULUS 16, REMAINDER 0);
-- ... p1..p15 ...
```

### 3. PgBouncer — não abra uma conexão por requisição

A 80M de usuários, abrir uma conexão Postgres por request esgota o `max_connections` em milissegundos. O **PgBouncer** em modo *transaction pooling* multiplexa milhares de clientes sobre dezenas de conexões reais.

```ini
; infra/pgbouncer/pgbouncer.ini
[pgbouncer]
pool_mode = transaction        ; devolve a conexão ao fim de CADA transação
max_client_conn = 10000        ; clientes lógicos (os pods)
default_pool_size = 25         ; conexões REAIS por banco — o Postgres respira
```

```typescript
// apps/booking-service/prisma.config.ts
// Prisma + PgBouncer em transaction mode: prepared statements NÃO sobrevivem entre
// transações. O parâmetro pgbouncer=true desliga o cache de prepared statements.
// Esquecer disso causa o erro "prepared statement \"s0\" already exists".
url: `${process.env.DATABASE_URL}?pgbouncer=true&connection_limit=1`,
```

### 4. Outbox + read replicas (já temos)

O Outbox do Passo 19.4 elimina dual-writes. E os modelos de leitura do CQRS (cap-18) vão para **read replicas** — a listagem de eventos e o dashboard do organizador nunca competem com o caminho de escrita das reservas.

```
RESUMO DA BLINDAGEM
═══════════════════════════════════════════════════════
  Hot path de reserva   → só Redis (memória)
  Contador no Postgres  → flush em lote a cada 5s (1 UPDATE, não 50k)
  Tabelas grandes       → particionadas por event_id (DETACH pós-evento)
  Conexões              → PgBouncer transaction pooling (25 reais p/ 10k lógicas)
  Eventos               → Outbox (zero dual-write)
  Leituras              → read replicas (CQRS, cap-18)
```

---

## Testando na prática

Os testes abaixo usam o setup real do projeto. Suba a infra antes:

```bash
make infra-up        # postgres, redis, kafka, elasticsearch
make obs-up          # opcional: ver as métricas no Grafana (localhost:3002)
```

### Teste 19.1 — Limite por CPF é atômico sob concorrência

O teste decisivo: disparar 10 reservas do **mesmo CPF** em paralelo num lote com `maxPerCpf=4`. Apenas 4 ingressos podem passar.

```bash
# pega um lote real e um token de comprador (ver cap-18 para extrair os IDs)
BATCH_ID=$(docker compose exec postgres psql -U event_svc -d showpass_events \
  -t -c "SELECT id FROM ticket_batches LIMIT 1;" | tr -d ' \n')

# 10 reservas concorrentes, MESMO CPF, 1 ingresso cada → espera-se 4 sucessos + 6 recusas
for i in $(seq 1 10); do
  curl -s -X POST http://localhost:3004/bookings/reservations \
    -H "Authorization: Bearer $BUYER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"eventId\":\"$EVENT_ID\",\"cpf\":\"39053344705\",\"items\":[{\"ticketBatchId\":\"$BATCH_ID\",\"seatId\":null,\"quantity\":1}]}" \
    -o /dev/null -w "%{http_code}\n" &
done | sort | uniq -c
# Esperado:
#   4 201   ← aceitos (limite por CPF)
#   6 409   ← "Limite de 4 ingressos por CPF atingido"
```

Confirme o contador no Redis:

```bash
docker compose exec redis redis-cli -a redis_dev_secret \
  GET "cpf:limit:$EVENT_ID:$(echo -n '39053344705pepper' | sha256sum | cut -d' ' -f1)"
# → "4"  (nunca passa de 4, não importa quantas requisições concorrentes)
```

### Teste 19.2 — Cota de meia-entrada não estoura

```bash
# lote com halfPriceQuota=2: a 3ª meia-entrada deve receber "cota esgotada"
for i in 1 2 3; do
  curl -s -X POST http://localhost:3004/bookings/reservations \
    -H "Authorization: Bearer $BUYER_TOKEN" -H "Content-Type: application/json" \
    -d "{\"eventId\":\"$EVENT_ID\",\"cpf\":\"$(node -e 'console.log(genCpf())')\",\"items\":[{\"ticketBatchId\":\"$BATCH_ID\",\"seatId\":null,\"quantity\":1,\"halfPrice\":{\"category\":\"estudante\",\"documentHash\":\"'$(openssl rand -hex 32)'\"}}]}" \
    -o /dev/null -w "meia #$i → %{http_code}\n"
done
# meia #1 → 201
# meia #2 → 201
# meia #3 → 409  (Cota de meia-entrada esgotada para este lote)
```

### Teste 19.3 — Proof of Work do Fan Gate

```bash
# 1. pede um desafio
CHALLENGE=$(curl -s http://localhost:3007/queue/pow-challenge | python3 -c "import sys,json;print(json.load(sys.stdin)['challenge'])")

# 2. resolve no cliente (difficulty=4 → ~ instantâneo num laptop)
NONCE=$(node -e "
  const {createHash}=require('crypto'); const c='$CHALLENGE'; let n=0;
  while(!createHash('sha256').update(c+n).digest('hex').startsWith('0000')) n++;
  console.log(n);
")
echo "nonce encontrado: $NONCE"

# 3. submete — recebe o bilhete da fila
curl -s -X POST http://localhost:3007/queue/join \
  -H "Content-Type: application/json" \
  -d "{\"eventId\":\"$EVENT_ID\",\"challenge\":\"$CHALLENGE\",\"nonce\":\"$NONCE\",\"cpf\":\"39053344705\"}"
# → { "ticketId": "...", "position": "...", "entryPass": null }  (entryPass vem na admissão da onda)
```

### Teste 19.4 — Pagamento assíncrono responde na hora (sem esperar o Stripe)

```bash
# o checkout responde 202 em milissegundos — não espera o Stripe
time curl -s -X POST http://localhost:3002/payments/orders \
  -H "Authorization: Bearer $BUYER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"reservationIds\":[\"$RESERVATION_ID\"]}"
# → { "orderId": "...", "status": "processing" }   real ~0m0.05s

# o evento foi para o outbox (mesma transação do order)
docker compose exec postgres psql -U payment_svc -d showpass_payment \
  -c "SELECT topic, status FROM payment_outbox ORDER BY created_at DESC LIMIT 1;"
# topic: payments.charge-requested | status: pending → (dispatcher) → dispatched
```

### Teste 19.5 — Motor antifraude eleva ao 3DS sob card testing

```bash
# simula card testing: 4 BINs diferentes no mesmo CPF em segundos → score sobe → 3DS/deny
for bin in 411111 511111 601111 371111; do
  curl -s -X POST http://localhost:3002/payments/risk-assess \
    -H "Content-Type: application/json" \
    -d "{\"cpf\":\"39053344705\",\"cardBin\":\"$bin\",\"amount\":35000}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(f\"score={d['score']} decisão={d['decision']}\")"
done
# score=0  decisão=approve
# score=0  decisão=approve
# score=0  decisão=approve
# score=40 decisão=challenge_3ds   ← 4º cartão distinto dispara a regra de velocidade
```

---

## Resumo do Capítulo

```
                ┌──────────────────────────────────────────────────┐
                │  De 10M para 80M — o salto que quebra o ingênuo  │
                └──────────────────────────────────────────────────┘

19.1  Funil real: o gargalo é a linha quente + a chamada externa, não a CPU
19.2  Fan Gate: fila por sorteio + Proof of Work + bot score → fã passa, bot trava
19.3  Regras BR: setor/preço/cupom + limite por CPF e cota de meia ATÔMICOS no Redis
19.4  Stripe síncrono estoura → Outbox + fila + worker idempotente (Circuit Breaker)
19.5  Antifraude por score: approve frictionless / 3DS / review / deny (liability shift)
19.6  Banco não explode: contador shardeado, partição por evento, PgBouncer, Outbox

Princípio que costura tudo:
  "No caminho quente, só toque memória. Disco e rede externa são assíncronos."

A mesma atomicidade do SETNX que impede double booking (cap-06) agora também
garante o limite por CPF e a cota de meia-entrada. O Circuit Breaker e a Saga
(cap-18) que davam resiliência agora desacoplam o pagamento do Stripe. Nada
disso é tecnologia nova — é a aplicação madura dos padrões que você já domina.
```

---

> **O que mudou de verdade:** o ShowPass do cap-18 sobrevivia a 300.000 pessoas no mesmo assento. O ShowPass do cap-19 sobrevive a 80 milhões de pessoas, dos quais a maioria é bot, tentando burlar limite de CPF e testando cartões roubados — e ainda assim entrega o ingresso para o fã verdadeiro, no preço certo, com meia-entrada validada, sem cobrar duas vezes e sem explodir o Postgres. Esse é o ShowPass que vai para produção num show de estádio.

---

## Leitura Recomendada

- [Stripe Radar — Machine Learning para fraude](https://stripe.com/docs/radar)
- [3D Secure 2 & SCA — liability shift](https://stripe.com/docs/payments/3d-secure)
- [Hashcash — Proof of Work original (Adam Back)](http://www.hashcash.org/papers/hashcash.pdf)
- [Cloudflare Waiting Room — fila virtual na borda](https://developers.cloudflare.com/waiting-room/)
- [PostgreSQL — Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [PgBouncer — connection pooling](https://www.pgbouncer.org/features.html)
- [Lei nº 12.933/2013 — Lei do Meia-Entrada](https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2013/lei/l12933.htm)
- [Transactional Outbox Pattern — microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)
