// apps/web/src/app/(public)/events/[slug]/event-page.client.tsx
//
// Por que este é um Client Component?
// useState, useEffect e manipulação do router exigem execução no browser.
// O Server Component pai (page.tsx) já fez o fetch inicial — aqui apenas
// gerenciamos interação, polling e criação da reserva.
'use client';

import type React from 'react';
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

export function EventPageClient({ event }: Props): React.JSX.Element {
  const router = useRouter();
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [seatStatuses, setSeatStatuses] = useState<
    Record<string, SeatStatus>
  >({});
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [isCreatingReservation, setIsCreatingReservation] = useState(false);

  // Por que não existe `event.hasSeatingMap`?
  // O campo não existe no banco — seria informação derivada. Em vez de
  // adicionar um campo calculado ao schema do Prisma (que precisaria de
  // migration), derivamos aqui: se alguma seção tem assentos cadastrados
  // com coordenadas, o mapa SVG existe.
  const hasSeatingMap = event.venue.sections.some((s) => s.seats.length > 0);

  // Todos os seatIds visíveis no mapa — payload do polling
  const allSeatIds = event.venue.sections.flatMap((s) =>
    s.seats.map((seat) => seat.id),
  );
  const seatIdsKey = allSeatIds.join(',');

  // Polling de disponibilidade a cada 8s.
  // Por que 8s e não mais rápido?
  // O endpoint cruza Redis + Postgres (duas leituras por seatId). Com 500
  // assentos, 200ms de latência e 100 usuários na página = ~10.000 req/s
  // se o intervalo for 1s. 8s mantém carga baixa com UX aceitável.
  useEffect(() => {
    if (!hasSeatingMap || seatIdsKey.length === 0) return;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/bookings/reservations/availability/${event.id}?seatIds=${seatIdsKey}`,
        );
        if (!response.ok) return;
        const data = (await response.json()) as Record<string, SeatStatus>;
        setSeatStatuses((prev) => {
          const next = { ...prev };
          for (const [seatId, status] of Object.entries(data)) {
            // Não sobrescrever assentos que o próprio usuário selecionou —
            // 'selected' é estado local e não existe no backend.
            if (next[seatId] !== 'selected') {
              next[seatId] = status;
            }
          }
          return next;
        });
      } catch {
        // Falha silenciosa — o mapa não atualiza neste ciclo.
      }
    };

    void poll();
    const interval = setInterval(() => {
      void poll();
    }, 8_000);
    return (): void => {
      clearInterval(interval);
    };
  }, [event.id, hasSeatingMap, seatIdsKey]);

  const handleSeatClick = useCallback(
    (seatId: string): void => {
      const currentStatus = seatStatuses[seatId] ?? 'available';

      if (currentStatus === 'locked' || currentStatus === 'sold') return;

      setSelectedSeatIds((prev) => {
        const isSelected = prev.includes(seatId);
        if (isSelected) {
          return prev.filter((id) => id !== seatId);
        }
        if (prev.length >= event.maxTicketsPerOrder) return prev;
        return [...prev, seatId];
      });

      // Optimistic UI: muda a cor imediatamente
      setSeatStatuses((prev) => ({
        ...prev,
        [seatId]: prev[seatId] === 'selected' ? 'available' : 'selected',
      }));
    },
    [seatStatuses, event.maxTicketsPerOrder],
  );

  const handleReserve = async (): Promise<void> => {
    if (!selectedBatchId) return;

    const hasSeats = selectedSeatIds.length > 0;
    if (hasSeatingMap && !hasSeats) return;

    setIsCreatingReservation(true);

    try {
      // Por que useAuthStore.getState() e não o hook?
      // Esta função é chamada de um handler de evento (onClick), não do
      // corpo do componente — hooks só rodam no render.
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
            // OWASP A07: JWT via Authorization header (não cookie) para
            // evitar CSRF em requisições cross-origin do API Gateway.
            Authorization: `Bearer ${token ?? ''}`,
          },
          body: JSON.stringify({ eventId: event.id, items }),
        },
      );

      if (response.status === 409) {
        const err = (await response.json()) as {
          message: string;
          unavailableSeatIds: string[];
        };
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

      const data = (await response.json()) as { id: string };
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
            {selectedSeatIds.length} assento
            {selectedSeatIds.length > 1 ? 's' : ''} selecionado
            {selectedSeatIds.length > 1 ? 's' : ''}
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
        onClick={() => {
          void handleReserve();
        }}
      >
        {isCreatingReservation ? 'Reservando...' : 'Reservar Agora'}
      </Button>

      <p className="text-xs text-gray-400 text-center mt-2">
        Reserva válida por 7 minutos
      </p>
    </div>
  );
}
