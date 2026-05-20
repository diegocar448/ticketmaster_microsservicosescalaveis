# Capítulo 11 — Event Pages & Seat Map

> **Objetivo:** Renderizar a página do evento como Server Component para SEO máximo, e o mapa de assentos como SVG interativo com disponibilidade atualizada por polling.

## O que você vai aprender

- `generateMetadata()` com Open Graph + Schema.org para eventos
- Server Component busca dados no servidor — zero waterfall client-side
- Corrigir um bug real no backend: endpoint de disponibilidade recebe `seatIds` via `@Body` em um `GET` (inválido) — migrar para query param
- Mapa de assentos SVG interativo — selecionar, destacar, múltiplos assentos
- Polling a cada 8s para atualizar disponibilidade em tempo real (decisão arquitetural explicada)
- Optimistic UI: assento responde imediatamente ao clique, reverte em caso de conflito

---

## Decisão arquitetural — Polling em vez de WebSocket

> **Box de contexto:** Em projetos reais, WebSocket parece a solução óbvia para "atualizar o mapa em tempo real". Por que não fizemos isso aqui?

O backend atual **não expõe nenhuma porta WebSocket**. Nenhum dos microserviços (api-gateway, booking-service, event-service) inclui um gateway WS. Adicionar WebSocket real envolve:

1. Escalar horizontalmente o nó WS com sticky sessions ou pub/sub via Redis
2. Implementar heartbeat, reconexão e back-pressure
3. Definir um protocolo de mensagens (JSON-RPC, socket.io rooms, etc.)
4. Gerenciar autenticação na abertura do handshake

Para a fase atual do tutorial, o custo de implementação supera o benefício. O **polling a cada 8 segundos** entrega ~99 % da experiência com zero infraestrutura adicional — a mesma filosofia do cap-08, que usou domain events em vez de Debezium porque a complexidade operacional de CDC não fazia sentido naquele ponto da curva de aprendizado.

**Trade-offs:**

| Característica      | Polling 8s           | WebSocket real              |
|---------------------|----------------------|-----------------------------|
| Latência percebida  | ≤ 8s                 | < 1s                        |
| Infraestrutura extra| Nenhuma              | Redis pub/sub + sticky load |
| Reconexão           | Automática (timer)   | Lógica explícita            |
| HTTP/2 multiplexing | Sim (fetch padrão)   | Protocolo separado          |
| Implementação       | ~10 linhas           | ~200 linhas (+ backend)     |

A evolução para WebSocket real está prevista no cap-18 (padrões avançados), quando o cluster Kubernetes do cap-16 já estiver de pé.

---

## Passo 11.1 — Corrigir o endpoint de disponibilidade no backend

Antes de construir o frontend, precisamos corrigir um bug no `booking-service`: o endpoint `GET /bookings/reservations/availability/:eventId` usa `@Body('seatIds')` — **um GET request não carrega body** na maioria dos proxies e browsers. A correção é mover `seatIds` para um query param.

```typescript
// apps/booking-service/src/modules/reservations/reservations.controller.ts
//
// Por que @Query em vez de @Body?
// HTTP GET semanticamente não tem body. Nginx, AWS ALB e muitos
// intermediários descartam o body silenciosamente — a requisição chega
// ao NestJS com seatIds = undefined e o retorno fica sempre vazio.
// Query params são a forma canônica de filtros em GET requests (REST).

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,           // ← adicionar
  UseGuards,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service.js';
import { SeatLockService } from '../locks/seat-lock.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BuyerGuard } from '../../common/guards/buyer.guard.js';
import { CurrentUser, type AuthenticatedUser } from '@showpass/types/nest';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CreateReservationSchema, type CreateReservationDto } from '@showpass/types';

@Controller('bookings/reservations')
export class ReservationsController {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly seatLock: SeatLockService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @UseGuards(BuyerGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateReservationSchema)) dto: CreateReservationDto,
  ) {
    return this.reservationsService.create(user.id, dto);
  }

  @Get(':id')
  @UseGuards(BuyerGuard)
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!reservation || reservation.buyerId !== user.id) {
      throw new NotFoundException('Reserva não encontrada');
    }

    const [event, batches] = await Promise.all([
      this.prisma.event.findUnique({
        where: { id: reservation.eventId },
        select: { title: true, thumbnailUrl: true },
      }),
      this.prisma.ticketBatch.findMany({
        where: { id: { in: reservation.items.map((i) => i.ticketBatchId) } },
        select: { id: true, name: true },
      }),
    ]);

    if (!event) {
      throw new NotFoundException(
        'Evento ainda não foi replicado — tente novamente em instantes',
      );
    }

    const batchNameById = new Map(batches.map((b: { id: string; name: string }) => [b.id, b.name]));

    return {
      ...reservation,
      items: reservation.items.map((item) => ({
        ...item,
        ticketBatchName: batchNameById.get(item.ticketBatchId) ?? '',
        seatLabel: null,
        eventTitle: event.title,
        thumbnailUrl: event.thumbnailUrl,
      })),
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(BuyerGuard)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reservationsService.cancel(id, user.id);
  }

  /**
   * Verificar disponibilidade de assentos para o mapa SVG.
   *
   * Por que cruzar Redis + Postgres?
   * — Redis tem os locks ativos (TTL 7 min) de reservas em andamento.
   * — Postgres tem os assentos efetivamente vendidos (status = sold).
   * Um assento pode estar "livre no banco" mas "lockado no Redis" por outro
   * comprador no checkout agora. Checar só um dos dois geraria falsos disponíveis.
   *
   * O caller (frontend) envia apenas os seatIds visíveis no viewport atual —
   * sem esse filtro, um venue com 10.000 assentos dispararia verificações
   * desnecessárias. A resposta é Record<seatId, 'available'|'locked'|'sold'>.
   *
   * Exemplo de chamada:
   *   GET /bookings/reservations/availability/uuid?seatIds=uuid1,uuid2,uuid3
   */
  @Get('availability/:eventId')
  getAvailability(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Query('seatIds') seatIds: string,   // ← era @Body('seatIds') string[]
  ) {
    // split('') em string vazia retorna [''] — filtramos para não passar
    // UUIDs vazios ao SeatLockService (causaria query malformada no Redis).
    const ids = seatIds ? seatIds.split(',').filter(Boolean) : [];
    return this.seatLock.checkAvailability(eventId, ids);
  }
}
```

> **Por que mostramos o controller inteiro?** Para não deixar nenhuma ambiguidade sobre onde a mudança se encaixa — apenas o método `getAvailability` foi alterado (assinatura + lógica de split). Os demais métodos são exatamente como estavam antes.

---

## Passo 11.2 — `getEventBySlug` e os dois schemas de evento

O `getEventBySlug` já foi definido no cap-10 (Passo 10.4) validando com
`EventPublicResponseSchema` — não por acaso. Vale entender **por que** existem
dois schemas distintos, porque é exatamente isso que faz o mapa de assentos
funcionar:

```typescript
// apps/web/src/lib/api/events.ts (já criado no cap-10 — relembrando)
//
// Por que dois schemas diferentes?
// EventResponseSchema      → resumo da LISTAGEM (GET /events): sem seções,
//                            sem lotes. Usado em getMyEvents/searchEvents.
// EventPublicResponseSchema → DETALHE público (GET /events/:slug/public):
//                            inclui venue.sections[].seats[] e ticketBatches[].
//
// Se getEventBySlug validasse com o schema resumido, o Zod faria strip
// (comportamento padrão) de venue.sections e ticketBatches — e o SeatMap
// renderizaria em branco, sem nenhum erro explícito. Por isso o cap-10 já
// usa EventPublicResponseSchema aqui.

export async function getEventBySlug(slug: string) {
  return apiRequest(
    `/events/${slug}/public`,
    EventPublicResponseSchema,  // detalhe completo com venue.sections
    { skipAuth: true },
  );
}
```

> **Pegadinha de Zod silenciosa:** validar com o schema errado não lança erro
> — `.strip()` (default) apenas remove os campos não declarados. O sintoma é
> `event.venue.sections` chegando `undefined` e o mapa vazio. Manter um schema
> por *forma de resposta* (resumo vs detalhe) evita essa classe de bug.

---

## Passo 11.3 — Página do Evento (Server Component + SEO)

```typescript
// apps/web/src/app/(public)/events/[slug]/page.tsx
//
// Server Component — renderizado no servidor com dados frescos.
// O HTML final já contém título, descrição, OG tags e Schema.org.
// Google indexa o evento completo sem precisar de JavaScript.
//
// Next.js 16: `params` é uma Promise — obrigatório `await params`
// antes de acessar qualquer campo. Omitir o await causa TypeError
// silencioso em produção (os campos aparecem como undefined).

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getEventBySlug } from '@/lib/api/events';
import { EventPageClient } from './event-page.client';
import { SeatMapSkeleton } from '@/components/events/seat-map-skeleton';

// ─── SEO: Open Graph + Schema.org ────────────────────────────────────────────

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  // await obrigatório em Next 16 — params é Promise
  const { slug } = await params;

  try {
    const event = await getEventBySlug(slug);

    return {
      title: event.title,
      description: `${event.title} — ${event.venue.name}, ${event.venueCity}/${event.venueState}. Compre seus ingressos no ShowPass.`,
      openGraph: {
        title: event.title,
        description: `${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full' }).format(new Date(event.startAt))} • ${event.venue.name}`,
        images: event.thumbnailUrl ? [{ url: event.thumbnailUrl, width: 1200, height: 630 }] : [],
        type: 'website',
      },
      twitter: {
        card: 'summary_large_image',
        title: event.title,
        images: event.thumbnailUrl ? [event.thumbnailUrl] : [],
      },
    };
  } catch {
    return { title: 'Evento não encontrado' };
  }
}

// ─── Página ───────────────────────────────────────────────────────────────────

export default async function EventPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const event = await getEventBySlug(slug).catch(() => null);

  if (!event) {
    notFound();
  }

  const eventDate = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(event.startAt));

  // Schema.org minPrice: menor preço entre os lotes visíveis e com estoque
  const minPrice = event.ticketBatches
    .filter((b) => b.isVisible && b.soldCount < b.totalQuantity)
    .reduce<number | null>((min, b) => (min === null || b.price < min ? b.price : min), null);

  const hasAvailableTickets = minPrice !== null;

  return (
    <>
      {/* Schema.org Event — dados estruturados para o Google */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Event',
            name: event.title,
            startDate: event.startAt,
            endDate: event.endAt,
            location: {
              '@type': 'Place',
              name: event.venue.name,
              address: {
                '@type': 'PostalAddress',
                streetAddress: event.venue.address,
                addressLocality: event.venueCity,
                addressRegion: event.venueState,
                addressCountry: 'BR',
              },
            },
            offers: minPrice !== null
              ? {
                  '@type': 'Offer',
                  availability: hasAvailableTickets
                    ? 'https://schema.org/InStock'
                    : 'https://schema.org/SoldOut',
                  price: minPrice,
                  priceCurrency: 'BRL',
                  url: `https://showpass.com.br/events/${slug}`,
                }
              : undefined,
            image: event.thumbnailUrl,
            organizer: { '@type': 'Organization', name: event.organizer.name },
          }),
        }}
      />

      <main className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            {event.thumbnailUrl && (
              <div className="relative w-full aspect-video rounded-2xl overflow-hidden mb-6">
                <img
                  src={event.thumbnailUrl}
                  alt={event.title}
                  className="object-cover w-full h-full"
                />
              </div>
            )}

            <h1 className="text-3xl font-bold mb-2">{event.title}</h1>
            <p className="text-gray-600 mb-1 capitalize">{eventDate}</p>
            <p className="text-gray-600 mb-6">
              {event.venue.name} • {event.venueCity}/{event.venueState}
            </p>

            <div className="prose max-w-none">
              <p>{event.description}</p>
            </div>
          </div>

          {/* Painel lateral — Client Component (interatividade + polling) */}
          <div className="lg:col-span-1">
            <Suspense fallback={<SeatMapSkeleton />}>
              <EventPageClient event={event} />
            </Suspense>
          </div>
        </div>
      </main>
    </>
  );
}
```

---

## Passo 11.4 — Client Component com Seat Map e polling

```typescript
// apps/web/src/app/(public)/events/[slug]/event-page.client.tsx
'use client';

//
// Por que este é um Client Component?
// useState, useEffect e manipulação do router exigem execução no browser.
// O Server Component pai (page.tsx) já fez o fetch inicial — aqui apenas
// gerenciamos interação, polling e criação da reserva.

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { SeatMap } from '@/components/events/seat-map';
import { TicketBatchSelector } from '@/components/events/ticket-batch-selector';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth-store';
import type { EventPublicResponse } from '@showpass/types';

interface Props {
  event: EventPublicResponse;
}

type SeatStatus = 'available' | 'locked' | 'sold' | 'selected';

export function EventPageClient({ event }: Props) {
  const router = useRouter();
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [seatStatuses, setSeatStatuses] = useState<Record<string, SeatStatus>>({});
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [isCreatingReservation, setIsCreatingReservation] = useState(false);

  // ─── Derivar se o evento tem mapa de assentos ─────────────────────────────
  //
  // Por que não existe `event.hasSeatingMap`?
  // O campo não existe no banco — seria informação derivada. Em vez de
  // adicionar um campo calculado ao schema do Prisma (que precisaria de
  // migration), derivamos aqui: se alguma seção tem assentos cadastrados
  // com coordenadas, o mapa SVG existe. Caso contrário, exibimos apenas
  // o seletor de lotes (ingresso avulso, sem assento numerado).
  const hasSeatingMap = event.venue.sections.some((s) => s.seats.length > 0);

  // Todos os seatIds visíveis no mapa — usados no payload do polling
  const allSeatIds = event.venue.sections.flatMap((s) => s.seats.map((seat) => seat.id));

  // ─── Polling de disponibilidade a cada 8s ─────────────────────────────────
  //
  // Por que 8s e não mais rápido?
  // O endpoint cruza Redis + Postgres (duas leituras por seatId). Com 500
  // assentos, 200 ms de latência e 100 usuários na página = ~10.000 req/s
  // se o intervalo for 1s. 8s mantém carga baixa com UX aceitável — quem
  // está escolhendo assento não percebe diferença entre 1s e 8s.
  //
  // Mandamos apenas os seatIds visíveis (?seatIds=a,b,c) para não
  // sobrecarregar o backend com verificações de assentos fora do viewport.
  useEffect(() => {
    if (!hasSeatingMap || allSeatIds.length === 0) return;

    const poll = async () => {
      try {
        const query = allSeatIds.join(',');
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/bookings/reservations/availability/${event.id}?seatIds=${query}`,
        );
        if (!response.ok) return;
        const data = await response.json() as Record<string, SeatStatus>;
        setSeatStatuses((prev) => {
          const next = { ...prev };
          for (const [seatId, status] of Object.entries(data)) {
            // Não sobrescrever assentos que o próprio usuário selecionou —
            // o status 'selected' é local e não existe no backend.
            if (next[seatId] !== 'selected') {
              next[seatId] = status;
            }
          }
          return next;
        });
      } catch {
        // Falha silenciosa — o mapa simplesmente não atualiza neste ciclo.
        // O usuário não perde dados nem vê erro desnecessário.
      }
    };

    // Primeira chamada imediata para popular o mapa ao montar o componente
    void poll();
    const interval = setInterval(poll, 8_000);
    return () => clearInterval(interval);
  }, [event.id, hasSeatingMap, allSeatIds.join(',')]);

  // ─── Selecionar/deselecionar assento ──────────────────────────────────────
  const handleSeatClick = useCallback((seatId: string) => {
    const currentStatus = seatStatuses[seatId] ?? 'available';

    // Assento bloqueado por outro comprador ou vendido — clique ignorado
    if (currentStatus === 'locked' || currentStatus === 'sold') return;

    setSelectedSeatIds((prev) => {
      const isSelected = prev.includes(seatId);
      if (isSelected) {
        return prev.filter((id) => id !== seatId);
      }
      // Limitar ao máximo permitido pelo evento (ex: 4 ingressos/pedido)
      if (prev.length >= event.maxTicketsPerOrder) return prev;
      return [...prev, seatId];
    });

    // Optimistic UI: muda a cor imediatamente, sem esperar o próximo poll
    setSeatStatuses((prev) => ({
      ...prev,
      [seatId]: prev[seatId] === 'selected' ? 'available' : 'selected',
    }));
  }, [seatStatuses, event.maxTicketsPerOrder]);

  // ─── Criar reserva ────────────────────────────────────────────────────────
  const handleReserve = async () => {
    if (!selectedBatchId) return;

    // Para eventos sem mapa (ingresso avulso), reservamos 1 ingresso sem seatId
    const hasSeats = selectedSeatIds.length > 0;
    if (hasSeatingMap && !hasSeats) return;

    setIsCreatingReservation(true);

    try {
      // Por que useAuthStore.getState() e não o hook useAuthStore()?
      // Esta função é chamada de um handler de evento (onClick), não de
      // dentro do render. Hooks só podem ser chamados no corpo do componente.
      // getState() acessa o store Zustand de forma imperativa e segura.
      const token = useAuthStore.getState().accessToken;

      const items = hasSeatingMap
        ? selectedSeatIds.map((seatId) => ({
            ticketBatchId: selectedBatchId,
            seatId,
            quantity: 1,
          }))
        : [{ ticketBatchId: selectedBatchId, quantity: 1 }];

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/bookings/reservations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // OWASP A07: token JWT via Authorization header (não cookie)
            // para evitar CSRF em requisições cross-origin do API Gateway.
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ eventId: event.id, items }),
        },
      );

      if (response.status === 409) {
        // Backend retorna { message, unavailableSeatIds } no 409
        const err = await response.json() as { message: string; unavailableSeatIds: string[] };
        // Marcar assentos indisponíveis no mapa para feedback visual imediato
        setSeatStatuses((prev) => {
          const next = { ...prev };
          for (const id of err.unavailableSeatIds) {
            next[id] = 'locked';
          }
          return next;
        });
        setSelectedSeatIds((prev) =>
          prev.filter((id) => !err.unavailableSeatIds.includes(id)),
        );
        return;
      }

      if (!response.ok) throw new Error('Erro ao criar reserva');

      const data = await response.json() as { id: string };
      // Reserva criada — redirecionar para checkout com o ID da reserva.
      // O TTL real da reserva é 7 minutos (LOCK_TTL_SECONDS = 420s no
      // booking-service). O checkout-service cancela automaticamente após
      // esse prazo se o pagamento não for confirmado.
      router.push(`/checkout?reservation=${data.id}`);

    } finally {
      setIsCreatingReservation(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border p-6 sticky top-8">
      <h2 className="text-xl font-bold mb-4">Selecione seus ingressos</h2>

      <TicketBatchSelector
        batches={event.ticketBatches}
        selectedBatchId={selectedBatchId}
        onSelect={setSelectedBatchId}
      />

      {/* Mapa SVG — renderiza apenas se alguma seção tem assentos cadastrados */}
      {hasSeatingMap && (
        <SeatMap
          sections={event.venue.sections}
          seatStatuses={seatStatuses}
          selectedSeatIds={selectedSeatIds}
          onSeatClick={handleSeatClick}
          className="mt-4"
        />
      )}

      {selectedSeatIds.length > 0 && (
        <div className="mt-4 p-4 bg-gray-50 rounded-lg">
          <p className="font-medium">
            {selectedSeatIds.length} assento{selectedSeatIds.length > 1 ? 's' : ''} selecionado{selectedSeatIds.length > 1 ? 's' : ''}
          </p>
        </div>
      )}

      <Button
        className="w-full mt-4"
        size="lg"
        disabled={
          !selectedBatchId ||
          (hasSeatingMap && selectedSeatIds.length === 0) ||
          isCreatingReservation
        }
        onClick={handleReserve}
      >
        {isCreatingReservation ? 'Reservando...' : 'Reservar Agora'}
      </Button>

      <p className="text-xs text-gray-400 text-center mt-2">
        Reserva válida por 7 minutos
      </p>
    </div>
  );
}
```

---

## Passo 11.5 — SVG Seat Map Component

```typescript
// apps/web/src/components/events/seat-map.tsx
'use client';

//
// Por que SVG puro em vez de uma lib de seat map?
// Libs como `react-seat-map` ou `d3` adicionam 50–200 kB ao bundle e
// trazem opiniões sobre layout que não se encaixam no nosso schema de
// coordenadas (mapX/mapY arbitrários por assento). SVG nativo é mais
// leve, mais acessível (role/aria) e trivial de testar.

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { SectionResponseSchema } from '@showpass/types';
import { z } from 'zod';

// Inferir o tipo de seção diretamente do schema Zod — fonte única de verdade
type Section = z.infer<typeof SectionResponseSchema>;

type SeatStatus = 'available' | 'locked' | 'sold' | 'selected';

interface SeatMapProps {
  sections: Section[];
  seatStatuses: Record<string, SeatStatus>;
  selectedSeatIds: string[];
  onSeatClick: (seatId: string) => void;
  className?: string;
}

const STATUS_COLORS: Record<SeatStatus, string> = {
  available: '#22c55e',  // verde
  selected:  '#3b82f6',  // azul
  locked:    '#f97316',  // laranja — em checkout por outro usuário
  sold:      '#ef4444',  // vermelho — vendido definitivamente
};

const STATUS_LABELS: Record<SeatStatus, string> = {
  available: 'Disponível',
  selected:  'Selecionado',
  locked:    'Sendo reservado',
  sold:      'Vendido',
};

export function SeatMap({
  sections,
  seatStatuses,
  selectedSeatIds,
  onSeatClick,
  className,
}: SeatMapProps) {
  // Calcular dimensões do SVG baseado nas coordenadas reais dos assentos.
  // mapX/mapY podem ser null (Prisma schema os declara nullable) — nesses
  // casos usamos uma grade automática (index * 25) para não quebrar o render.
  const { width, height } = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    let autoIdx = 0;
    for (const section of sections) {
      for (const seat of section.seats) {
        const x = seat.mapX ?? autoIdx * 25;
        const y = seat.mapY ?? 0;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        autoIdx++;
      }
    }
    // Padding de 50px para não cortar o último círculo
    return { width: maxX + 50, height: maxY + 50 };
  }, [sections]);

  return (
    <div className={cn('overflow-auto', className)}>
      {/* Legenda visual */}
      <div className="flex gap-3 mb-3 flex-wrap">
        {(Object.entries(STATUS_COLORS) as [SeatStatus, string][]).map(([status, color]) => (
          <div key={status} className="flex items-center gap-1 text-xs text-gray-600">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
            {STATUS_LABELS[status]}
          </div>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Mapa de assentos"
      >
        {sections.map((section) => {
          // Seções general_admission não têm assentos individuais
          if (section.seatingType === 'general_admission') return null;

          return (
            <g key={section.id}>
              {/* Label da seção posicionado acima do primeiro assento */}
              {section.seats[0] && (
                <text
                  x={section.seats[0].mapX ?? 0}
                  y={(section.seats[0].mapY ?? 0) - 10}
                  fontSize="10"
                  fill="#666"
                >
                  {section.name}
                </text>
              )}

              {section.seats.map((seat, autoIdx) => {
                // Fallback de grade automática para assentos sem coordenadas
                const cx = (seat.mapX ?? autoIdx * 25) + 12;
                const cy = (seat.mapY ?? 0) + 12;

                const status: SeatStatus =
                  selectedSeatIds.includes(seat.id)
                    ? 'selected'
                    : (seatStatuses[seat.id] ?? 'available');

                const isClickable = status === 'available' || status === 'selected';

                return (
                  <g key={seat.id}>
                    <circle
                      cx={cx}
                      cy={cy}
                      r={10}
                      fill={STATUS_COLORS[status]}
                      stroke={status === 'selected' ? '#1d4ed8' : 'transparent'}
                      strokeWidth={2}
                      style={{ cursor: isClickable ? 'pointer' : 'not-allowed' }}
                      onClick={() => isClickable && onSeatClick(seat.id)}
                      role={isClickable ? 'button' : undefined}
                      aria-label={`Fileira ${seat.row}, Assento ${seat.number} — ${STATUS_LABELS[status]}`}
                      aria-pressed={status === 'selected'}
                    >
                      <title>{`${seat.row}${seat.number} — ${STATUS_LABELS[status]}`}</title>
                    </circle>

                    {/* Número do assento — só legível em zoom; pointer-events off */}
                    <text
                      x={cx}
                      y={cy + 4}
                      textAnchor="middle"
                      fontSize="7"
                      fill="white"
                      style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                      {seat.number}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
```

---

## Testando na prática

Este capítulo traz a primeira tela visualmente rica: a página do evento com o mapa de assentos interativo e disponibilidade atualizada por polling.

### O que precisa estar rodando

```bash
# Terminal 1 — infraestrutura (Postgres, Redis, Kafka, Elasticsearch)
docker compose up -d

# Terminal 2 — auth-service
pnpm --filter @showpass/auth-service run dev          # porta 3006

# Terminal 3 — event-service
pnpm --filter @showpass/event-service run dev         # porta 3003

# Terminal 4 — booking-service (com o fix do passo 11.1 aplicado)
pnpm --filter @showpass/booking-service run dev       # porta 3004

# Terminal 5 — api-gateway
pnpm --filter @showpass/api-gateway run dev           # porta 3000

# Terminal 6 — frontend
pnpm --filter @showpass/web run dev                   # porta 3001
```

### Passo a passo no browser

**1. Acessar a página do evento**

Acesse: **http://localhost:3001/events/$EVENT_SLUG**

> O `$EVENT_SLUG` foi gerado no cap-05 (slug do evento criado via `POST /events`).
> Como o service concatena um timestamp ao slug, não é exatamente `rock-in-rio-2025`;
> use o valor retornado pela API ou ajuste via Prisma Studio se quiser um slug fixo.

Você deve ver:
- Thumbnail, título, descrição e datas do evento
- Mapa de assentos SVG com assentos coloridos por status (se o venue tiver seções `reserved` com `seats[]` cadastrados)
- Seletor de lotes (TicketBatchSelector)
- Botão "Reservar Agora" desabilitado até selecionar lote + assento

Inspecione o código-fonte da página (Ctrl+U): os dados do evento já estão no HTML inicial — isso é o Server Component em ação. O Google indexa sem JavaScript.

**2. Verificar os meta tags de SEO**

No DevTools → Elements, procure no `<head>`:

```html
<title>Rock in Rio 2025 — ShowPass</title>
<meta property="og:title" content="Rock in Rio 2025" />
<meta property="og:image" content="..." />
<script type="application/ld+json">{"@type":"Event",...}</script>
```

**3. Selecionar assentos no mapa**

Clique em assentos disponíveis (verde). Eles devem mudar para azul imediatamente (optimistic UI). O contador "X assentos selecionados" deve atualizar.

**4. Testar o limite de ingressos por pedido**

Tente selecionar mais de `maxTicketsPerOrder` assentos (padrão: 4). O clique adicional deve ser ignorado silenciosamente.

**5. Verificar o polling de disponibilidade**

Abra a mesma página em duas abas diferentes (simula dois compradores). Na Aba 2, abra o DevTools → Network e filtre por `availability`. A cada ~8 segundos você verá requisições `GET /bookings/reservations/availability/:eventId?seatIds=...`.

Crie uma reserva na Aba 1. Em até 8 segundos, o assento deve aparecer laranja (locked) na Aba 2.

**6. Testar a correção do endpoint (Passo 11.1)**

No DevTools → Network da Aba 2, inspecione o response do poll:

```json
{
  "uuid-assento-1": "available",
  "uuid-assento-2": "locked",
  "uuid-assento-3": "available"
}
```

Se antes do fix você recebia `{}` vazio mesmo com assentos reservados, agora o response deve refletir o estado real — confirmando que o bug do `@Body` em GET foi resolvido.

**7. Testar conflito 409**

Com duas abas abertas, selecione o mesmo assento nas duas e clique "Reservar Agora" simultaneamente. Uma das abas vai receber 409 e o assento deve mudar para laranja (locked) com o seletor desmarcado.

**8. Testar com evento inexistente**

Acesse: **http://localhost:3001/events/nao-existe**

Você deve ver a página 404 padrão do Next.js (ou seu componente `not-found.tsx` se tiver criado).

---

## Recapitulando

1. **Patch no backend (Passo 11.1)** — `@Body('seatIds')` substituído por `@Query('seatIds')` no endpoint de disponibilidade; GET com body é silenciosamente ignorado por proxies
2. **Schema correto no frontend (Passo 11.2)** — `getEventBySlug` passou a usar `EventPublicResponseSchema` (shape completo com `venue.sections`) em vez do `EventResponseSchema` resumido
3. **Server Component** — página renderizada no servidor; HTML com Schema.org Event, Open Graph e Twitter Card entregue ao Google sem JavaScript
4. **`await params` (Next 16)** — `params` é `Promise<{ slug }>` em Server Components; esquecer o `await` gera `undefined` silencioso em produção
5. **Polling de 8s** — substitui WebSocket (inexistente no backend atual); baixa carga, UX aceitável, zero infraestrutura extra; evolução para WS real no cap-18
6. **`useAuthStore.getState().accessToken`** — forma correta de ler o token Zustand fora do ciclo de render (handler de evento); `localStorage.getItem('showpass-auth')` retornaria o JSON inteiro do persist, não o token
7. **`event.venue.sections`** — seções vêm aninhadas no venue; não existe `event.sections` nem `event.hasSeatingMap` no topo do objeto
8. **TTL de 7 minutos** — lock e reserva expiram em 420s (`LOCK_TTL_SECONDS` no booking-service); alinhado no frontend ("Reserva válida por 7 minutos")
9. **SVG com fallback de coordenadas** — `mapX/mapY` são nullable; grade automática garante que assentos sem posição ainda sejam exibidos

---

## Próximo capítulo

[Capítulo 12 → Checkout Flow](cap-12-checkout-flow.md)
