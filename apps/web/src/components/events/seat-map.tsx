// apps/web/src/components/events/seat-map.tsx
//
// Por que SVG puro em vez de uma lib de seat map?
// Libs como react-seat-map ou d3 adicionam 50–200 kB ao bundle e trazem
// opiniões sobre layout que não se encaixam no nosso schema de coordenadas
// (mapX/mapY arbitrários por assento). SVG nativo é mais leve, mais
// acessível (role/aria) e trivial de testar.
'use client';

import type React from 'react';
import { useMemo } from 'react';
import { z } from 'zod';
import { cn } from '@/lib/utils';
import { SectionResponseSchema } from '@showpass/types';

// Inferir o tipo de seção do schema Zod — fonte única de verdade
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
  available: '#22c55e',
  selected: '#3b82f6',
  locked: '#f97316',
  sold: '#ef4444',
};

const STATUS_LABELS: Record<SeatStatus, string> = {
  available: 'Disponível',
  selected: 'Selecionado',
  locked: 'Sendo reservado',
  sold: 'Vendido',
};

export function SeatMap({
  sections,
  seatStatuses,
  selectedSeatIds,
  onSeatClick,
  className,
}: SeatMapProps): React.JSX.Element {
  // Calcular dimensões do SVG baseado nas coordenadas reais dos assentos.
  // mapX/mapY podem ser null (Prisma os declara nullable) — nesses casos
  // usamos uma grade automática (index * 25) para não quebrar o render.
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
    return { width: maxX + 50, height: maxY + 50 };
  }, [sections]);

  return (
    <div className={cn('overflow-auto', className)}>
      <div className="flex gap-3 mb-3 flex-wrap">
        {(Object.entries(STATUS_COLORS) as [SeatStatus, string][]).map(
          ([status, color]) => (
            <div
              key={status}
              className="flex items-center gap-1 text-xs text-gray-600"
            >
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: color }}
              />
              {STATUS_LABELS[status]}
            </div>
          ),
        )}
      </div>

      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        className="w-full"
        role="img"
        aria-label="Mapa de assentos"
      >
        {sections.map((section) => {
          if (section.seatingType === 'general_admission') return null;

          return (
            <g key={section.id}>
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
                const cx = (seat.mapX ?? autoIdx * 25) + 12;
                const cy = (seat.mapY ?? 0) + 12;

                const status: SeatStatus = selectedSeatIds.includes(seat.id)
                  ? 'selected'
                  : (seatStatuses[seat.id] ?? 'available');

                const isClickable =
                  status === 'available' || status === 'selected';

                return (
                  <g key={seat.id}>
                    <circle
                      cx={cx}
                      cy={cy}
                      r={10}
                      fill={STATUS_COLORS[status]}
                      stroke={status === 'selected' ? '#1d4ed8' : 'transparent'}
                      strokeWidth={2}
                      style={{
                        cursor: isClickable ? 'pointer' : 'not-allowed',
                      }}
                      onClick={() => {
                        if (isClickable) onSeatClick(seat.id);
                      }}
                      role={isClickable ? 'button' : undefined}
                      aria-label={`Fileira ${seat.row}, Assento ${String(seat.number)} — ${STATUS_LABELS[status]}`}
                      aria-pressed={status === 'selected'}
                    >
                      <title>{`${seat.row}${String(seat.number)} — ${STATUS_LABELS[status]}`}</title>
                    </circle>

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
