// apps/web/src/components/checkout/order-summary.tsx
//
// Resumo derivado dos itens da reserva. O subtotal mostrado é
// `Σ unitPrice × quantity`. O total autoritativo — com taxa de serviço
// e impostos — fica na página do Stripe Checkout.

import type React from 'react';
import { cn } from '@/lib/utils';
import type { ReservationResponse } from '@showpass/types';

interface OrderSummaryProps {
  reservation: ReservationResponse;
  className?: string;
}

// `unitPrice` vem como reais (Prisma Decimal, z.coerce.number()) — formata direto,
// sem dividir por 100. O backend não armazena em centavos.
const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function OrderSummary({
  reservation,
  className,
}: OrderSummaryProps): React.JSX.Element {
  const subtotal = reservation.items.reduce(
    (acc, item) => acc + item.unitPrice * item.quantity,
    0,
  );

  return (
    <div className={cn('rounded-xl border p-4 bg-white', className)}>
      <h2 className="font-semibold text-lg mb-3">Resumo do pedido</h2>

      <ul className="space-y-2 mb-4">
        {reservation.items.map((item) => (
          <li key={item.id} className="flex justify-between text-sm">
            <span>
              {item.ticketBatchName ?? 'Ingresso'}
              {item.seatLabel ? ` — Assento ${item.seatLabel}` : ''}
              {item.quantity > 1 ? ` × ${String(item.quantity)}` : ''}
            </span>
            <span className="font-medium">
              {brl.format(item.unitPrice * item.quantity)}
            </span>
          </li>
        ))}
      </ul>

      <div className="border-t pt-3 flex justify-between font-semibold">
        <span>Subtotal</span>
        <span>{brl.format(subtotal)}</span>
      </div>

      {/* O Stripe adiciona taxas/impostos — total final aparece lá */}
      <p className="text-xs text-gray-400 mt-2">
        Taxas e encargos serão exibidos na página de pagamento do Stripe.
      </p>
    </div>
  );
}
