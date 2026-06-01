// apps/web/src/components/checkout/reservation-timer.tsx
//
// Countdown visual da reserva. A fonte do tempo é o `expiresAt` da reserva,
// que reflete o TTL do lock Redis (7 min, gerenciado pelo booking-service).
// O timer aqui é puramente visual: o lock no backend expira sozinho — este
// componente apenas antecipa o redirect e dá feedback ao comprador.
'use client';

import type React from 'react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface ReservationTimerProps {
  expiresAt: Date;
  onExpired: () => void;
  className?: string;
}

export function ReservationTimer({
  expiresAt,
  onExpired,
  className,
}: ReservationTimerProps): React.JSX.Element {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(
        0,
        Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
      if (remaining === 0) {
        clearInterval(interval);
        onExpired();
      }
    }, 1000);

    return (): void => {
      clearInterval(interval);
    };
  }, [expiresAt, onExpired]);

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  // Menos de 2 min → feedback urgente
  const isUrgent = secondsLeft < 120;

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-4 rounded-xl border-2',
        isUrgent ? 'border-red-400 bg-red-50' : 'border-yellow-400 bg-yellow-50',
        className,
      )}
    >
      <div
        className={cn(
          'text-3xl font-mono font-bold',
          isUrgent ? 'text-red-600' : 'text-yellow-700',
        )}
      >
        {String(minutes).padStart(2, '0')}:
        {String(seconds).padStart(2, '0')}
      </div>
      <div>
        <p
          className={cn(
            'font-medium',
            isUrgent ? 'text-red-700' : 'text-yellow-800',
          )}
        >
          {isUrgent ? '⚠️ Sua reserva está expirando!' : '⏱ Reserva temporária'}
        </p>
        <p className="text-sm text-gray-600">
          7 minutos para concluir o pagamento (TTL do lock Redis)
        </p>
      </div>
    </div>
  );
}
