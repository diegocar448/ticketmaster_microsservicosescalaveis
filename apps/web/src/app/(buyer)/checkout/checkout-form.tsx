// apps/web/src/app/(buyer)/checkout/checkout-form.tsx
//
// Client component do checkout. Faz 2 chamadas em sequência:
//   1. POST /payments/orders → { orderId, checkoutUrl, status }
//   2. GET /bookings/reservations/:id → expiresAt + itens enriquecidos
//
// O payment-service deliberadamente NÃO devolve expiresAt — a verdade do TTL
// vive no lock Redis gerenciado pelo booking-service (cap-06). Buscar da
// reserva garante que o countdown esteja sincronizado com o lock real.
'use client';

import type React from 'react';
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { apiRequest, ApiError } from '@/lib/api-client';
import {
  CreateOrderResponseSchema,
  ReservationResponseSchema,
  type ReservationResponse,
} from '@showpass/types';
import { ReservationTimer } from '@/components/checkout/reservation-timer';
import { OrderSummary } from '@/components/checkout/order-summary';
import { Button } from '@/components/ui/button';

interface CheckoutState {
  orderId: string;
  checkoutUrl: string;
  reservation: ReservationResponse;
}

export function CheckoutForm(): React.JSX.Element {
  const searchParams = useSearchParams();
  const router = useRouter();
  const reservationId = searchParams.get('reservation');

  const [checkout, setCheckout] = useState<CheckoutState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reservationId) {
      router.push('/');
      return;
    }

    const init = async (): Promise<void> => {
      const order = await apiRequest(
        '/payments/orders',
        CreateOrderResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({ reservationIds: [reservationId] }),
        },
      );

      const reservation = await apiRequest(
        `/bookings/reservations/${reservationId}`,
        ReservationResponseSchema,
      );

      setCheckout({
        orderId: order.orderId,
        checkoutUrl: order.checkoutUrl,
        reservation,
      });
    };

    init()
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError ? err.message : 'Erro ao iniciar o checkout',
        );
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [reservationId, router]);

  const handleReservationExpired = (): void => {
    router.push(`/checkout/cancel?order=${checkout?.orderId ?? ''}`);
  };

  const handleProceedToPayment = (): void => {
    if (checkout?.checkoutUrl) {
      // Redirect puro p/ Stripe Checkout (checkout.stripe.com).
      // Sem Stripe Elements: PCI fica 100% do lado do Stripe.
      window.location.href = checkout.checkoutUrl;
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-4">
          Não foi possível criar o pedido
        </h1>
        <p className="text-gray-600 mb-6">{error}</p>
        <Button
          onClick={() => {
            router.back();
          }}
        >
          Voltar
        </Button>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Finalizar Compra</h1>

      {checkout && (
        <ReservationTimer
          expiresAt={checkout.reservation.expiresAt}
          onExpired={handleReservationExpired}
          className="mb-6"
        />
      )}

      {checkout && (
        <OrderSummary reservation={checkout.reservation} className="mb-6" />
      )}

      <Button
        className="w-full"
        size="lg"
        onClick={handleProceedToPayment}
        disabled={!checkout}
      >
        Pagar com Stripe
      </Button>

      <p className="text-xs text-gray-400 text-center mt-3">
        Você será redirecionado para a página segura do Stripe
      </p>
    </div>
  );
}
