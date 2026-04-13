# Capítulo 11 — Event Pages & Seat Map

> **Objetivo:** Renderizar a página do evento como Server Component para SEO máximo, e o mapa de assentos como SVG interativo com atualização em tempo real via WebSocket.

## O que você vai aprender

- `generateMetadata()` com Open Graph + Schema.org para eventos
- Server Component busca dados no servidor — zero waterfall client-side
- Mapa de assentos SVG interativo — selecionar, destacar, multiplos assentos
- WebSocket para disponibilidade em tempo real (assentos ficam vermelhos ao serem reservados)
- Optimistic UI: assento selecionado responde imediatamente, confirma via server

---

## Passo 11.1 — Página do Evento (Server Component + SEO)

```typescript
// apps/web/src/app/(public)/events/[slug]/page.tsx
//
// Server Component — renderizado no servidor com dados frescos.
// O HTML final já contém título, descrição, OG tags e Schema.org.
// Google indexa o evento completo sem precisar de JavaScript.

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getEventBySlug } from '@/lib/api/events';
import { EventPageClient } from './event-page.client';
import { Suspense } from 'react';
import { SeatMapSkeleton } from '@/components/events/seat-map-skeleton';

interface Params {
  slug: string;
}

// ─── SEO: Open Graph + Schema.org ────────────────────────────────────────────

export async function generateMetadata(
  { params }: { params: Params }
): Promise<Metadata> {
  try {
    const event = await getEventBySlug(params.slug);

    return {
      title: event.title,
      description: `${event.title} — ${event.venueName}, ${event.venueCity}/${event.venueState}. Compre seus ingressos no ShowPass.`,
      openGraph: {
        title: event.title,
        description: `${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full' }).format(new Date(event.startAt))} • ${event.venueName}`,
        images: event.thumbnailUrl ? [{ url: event.thumbnailUrl, width: 1200, height: 630 }] : [],
        type: 'website',
      },
      // Twitter/X Card
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
  { params }: { params: Params }
): Promise<JSX.Element> {
  const event = await getEventBySlug(params.slug).catch(() => null);

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
              name: event.venueName,
              address: {
                '@type': 'PostalAddress',
                addressLocality: event.venueCity,
                addressRegion: event.venueState,
                addressCountry: 'BR',
              },
            },
            offers: {
              '@type': 'Offer',
              availability: event.availableTickets > 0
                ? 'https://schema.org/InStock'
                : 'https://schema.org/SoldOut',
              price: event.minPrice,
              priceCurrency: 'BRL',
              url: `https://showpass.com.br/events/${params.slug}`,
            },
            image: event.thumbnailUrl,
            organizer: { '@type': 'Organization', name: 'ShowPass' },
          }),
        }}
      />

      <main className="container mx-auto px-4 py-8">
        {/* Hero do evento */}
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
              {event.venueName} • {event.venueCity}/{event.venueState}
            </p>

            <div className="prose max-w-none">
              <p>{event.description}</p>
            </div>
          </div>

          {/* Painel lateral de compra — contém o Seat Map (Client Component) */}
          <div className="lg:col-span-1">
            <Suspense fallback={<SeatMapSkeleton />}>
              {/* EventPageClient é Client Component — usa useState, WebSocket */}
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

## Passo 11.2 — Client Component com Seat Map

```typescript
// apps/web/src/app/(public)/events/[slug]/event-page.client.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { SeatMap } from '@/components/events/seat-map';
import { TicketBatchSelector } from '@/components/events/ticket-batch-selector';
import { Button } from '@/components/ui/button';
import type { EventResponse } from '@showpass/types';

interface Props {
  event: EventResponse;
}

type SeatStatus = 'available' | 'locked' | 'sold' | 'selected';

export function EventPageClient({ event }: Props): JSX.Element {
  const router = useRouter();
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [seatStatuses, setSeatStatuses] = useState<Record<string, SeatStatus>>({});
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [isCreatingReservation, setIsCreatingReservation] = useState(false);

  // ─── WebSocket para disponibilidade em tempo real ─────────────────────────
  useEffect(() => {
    const ws = new WebSocket(
      `${process.env.NEXT_PUBLIC_WS_URL}/events/${event.id}/availability`,
    );

    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data as string) as {
        seatId: string;
        status: SeatStatus;
      };

      setSeatStatuses((prev) => ({
        ...prev,
        [data.seatId]: data.status,
      }));
    };

    ws.onerror = () => {
      // Fallback: polling a cada 10s se WebSocket falhar
      const interval = setInterval(async () => {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/bookings/reservations/availability/${event.id}`,
        );
        const data = await response.json() as Record<string, SeatStatus>;
        setSeatStatuses(data);
      }, 10_000);

      return () => clearInterval(interval);
    };

    return () => ws.close();
  }, [event.id]);

  // ─── Selecionar/deselecionar assento ──────────────────────────────────────
  const handleSeatClick = useCallback((seatId: string) => {
    const currentStatus = seatStatuses[seatId] ?? 'available';

    if (currentStatus === 'locked' || currentStatus === 'sold') {
      return;  // não pode selecionar
    }

    setSelectedSeatIds((prev) => {
      const isSelected = prev.includes(seatId);
      if (isSelected) {
        return prev.filter((id) => id !== seatId);
      }

      // Verificar limite por pedido
      if (prev.length >= event.maxTicketsPerOrder) {
        return prev;  // já no limite
      }

      return [...prev, seatId];
    });

    // Optimistic UI: marcar como selecionado imediatamente
    setSeatStatuses((prev) => ({
      ...prev,
      [seatId]: prev[seatId] === 'selected' ? 'available' : 'selected',
    }));
  }, [seatStatuses, event.maxTicketsPerOrder]);

  // ─── Criar reserva ────────────────────────────────────────────────────────
  const handleReserve = async (): Promise<void> => {
    if (!selectedBatchId || selectedSeatIds.length === 0) return;

    setIsCreatingReservation(true);

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/bookings/reservations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('showpass-auth')}`,
          },
          body: JSON.stringify({
            eventId: event.id,
            items: selectedSeatIds.map((seatId) => ({
              ticketBatchId: selectedBatchId,
              seatId,
              quantity: 1,
            })),
          }),
        },
      );

      if (response.status === 409) {
        const err = await response.json() as { unavailableSeatIds: string[] };
        // Marcar assentos indisponíveis no mapa
        err.unavailableSeatIds.forEach((id) => {
          setSeatStatuses((prev) => ({ ...prev, [id]: 'locked' }));
        });
        setSelectedSeatIds((prev) =>
          prev.filter((id) => !err.unavailableSeatIds.includes(id)),
        );
        return;
      }

      if (!response.ok) throw new Error('Erro ao criar reserva');

      const data = await response.json() as { id: string };
      router.push(`/checkout?reservation=${data.id}`);

    } finally {
      setIsCreatingReservation(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border p-6 sticky top-8">
      <h2 className="text-xl font-bold mb-4">Selecione seus assentos</h2>

      <TicketBatchSelector
        batches={event.ticketBatches}
        selectedBatchId={selectedBatchId}
        onSelect={setSelectedBatchId}
      />

      {event.hasSeatingMap && (
        <SeatMap
          sections={event.sections}
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
        disabled={selectedSeatIds.length === 0 || !selectedBatchId || isCreatingReservation}
        onClick={handleReserve}
      >
        {isCreatingReservation ? 'Reservando...' : 'Reservar Agora'}
      </Button>

      <p className="text-xs text-gray-400 text-center mt-2">
        Reserva válida por 15 minutos
      </p>
    </div>
  );
}
```

---

## Passo 11.3 — SVG Seat Map Component

```typescript
// apps/web/src/components/events/seat-map.tsx
'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

interface Seat {
  id: string;
  row: string;
  number: number;
  mapX: number;
  mapY: number;
  type: string;
}

interface Section {
  id: string;
  name: string;
  seatingType: string;
  seats: Seat[];
}

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
  locked:    '#f97316',  // laranja — sendo reservado por outro
  sold:      '#ef4444',  // vermelho — vendido
};

export function SeatMap({
  sections,
  seatStatuses,
  selectedSeatIds,
  onSeatClick,
  className,
}: SeatMapProps): JSX.Element {
  // Calcular dimensões do SVG baseado nas posições dos assentos
  const { width, height } = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    for (const section of sections) {
      for (const seat of section.seats) {
        if (seat.mapX > maxX) maxX = seat.mapX;
        if (seat.mapY > maxY) maxY = seat.mapY;
      }
    }
    return { width: maxX + 50, height: maxY + 50 };
  }, [sections]);

  return (
    <div className={cn('overflow-auto', className)}>
      {/* Legenda */}
      <div className="flex gap-3 mb-3 flex-wrap">
        {Object.entries(STATUS_COLORS).map(([status, color]) => (
          <div key={status} className="flex items-center gap-1 text-xs text-gray-600">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: color }}
            />
            {status === 'available' && 'Disponível'}
            {status === 'selected' && 'Selecionado'}
            {status === 'locked' && 'Sendo reservado'}
            {status === 'sold' && 'Vendido'}
          </div>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Mapa de assentos"
      >
        {sections.map((section) => (
          <g key={section.id}>
            {/* Label da seção */}
            <text
              x={section.seats[0]?.mapX ?? 0}
              y={(section.seats[0]?.mapY ?? 0) - 10}
              fontSize="10"
              fill="#666"
            >
              {section.name}
            </text>

            {/* Assentos */}
            {section.seats.map((seat) => {
              const status: SeatStatus =
                selectedSeatIds.includes(seat.id) ? 'selected' :
                (seatStatuses[seat.id] ?? 'available');

              const isClickable = status === 'available' || status === 'selected';

              return (
                <g key={seat.id}>
                  <circle
                    cx={seat.mapX + 12}
                    cy={seat.mapY + 12}
                    r={10}
                    fill={STATUS_COLORS[status]}
                    stroke={status === 'selected' ? '#1d4ed8' : 'transparent'}
                    strokeWidth={2}
                    style={{ cursor: isClickable ? 'pointer' : 'not-allowed' }}
                    onClick={() => isClickable && onSeatClick(seat.id)}
                    role={isClickable ? 'button' : undefined}
                    aria-label={`Fileira ${seat.row}, Assento ${seat.number} — ${status}`}
                    aria-pressed={status === 'selected'}
                  >
                    {/* Tooltip no hover */}
                    <title>{`${seat.row}${seat.number} — ${
                      status === 'available' ? 'Disponível' :
                      status === 'selected' ? 'Selecionado' :
                      status === 'locked' ? 'Sendo reservado' : 'Vendido'
                    }`}</title>
                  </circle>

                  {/* Número do assento (visível apenas quando há espaço) */}
                  <text
                    x={seat.mapX + 12}
                    y={seat.mapY + 16}
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
        ))}
      </svg>
    </div>
  );
}
```

---

## Recapitulando

1. **Server Component** para a página — SEO completo (Schema.org Event, Open Graph) no HTML inicial
2. **`generateMetadata()`** — title e OG tags por evento; Google indexa corretamente
3. **SVG interativo** — mapa de assentos com status coloridos, sem dependências externas
4. **WebSocket real-time** — assentos ficam laranjas quando outro usuário seleciona
5. **Fallback de polling** — se WebSocket falhar, polling a cada 10s garante consistência
6. **Optimistic UI** — assento responde imediatamente ao click; erro reverte o estado

---

## Próximo capítulo

[Capítulo 12 → Checkout Flow](cap-12-checkout-flow.md)
