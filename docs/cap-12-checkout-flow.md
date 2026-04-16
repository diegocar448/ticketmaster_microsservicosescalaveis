# Capítulo 12 — Checkout Flow

> **Objetivo:** Implementar o fluxo de checkout com Stripe Elements, countdown do tempo de reserva, e página de confirmação de compra.

## Passo 12.1 — Checkout Page

```typescript
// apps/web/src/app/(buyer)/checkout/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { loadStripe } from '@stripe/stripe-js';
import { apiRequest } from '@/lib/api-client';
import { OrderResponseSchema } from '@showpass/types';
import { ReservationTimer } from '@/components/checkout/reservation-timer';
import { OrderSummary } from '@/components/checkout/order-summary';
import { Button } from '@/components/ui/button';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

export default function CheckoutPage(): JSX.Element {
  const searchParams = useSearchParams();
  const router = useRouter();
  const reservationId = searchParams.get('reservation');

  const [order, setOrder] = useState<{ id: string; total: number; checkoutUrl: string; expiresAt: Date } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reservationId) {
      router.push('/');
      return;
    }

    // Criar o pedido e obter a Checkout Session URL do Stripe
    apiRequest(
      '/payments/orders',
      OrderResponseSchema,
      {
        method: 'POST',
        body: JSON.stringify({ reservationIds: [reservationId] }),
      },
    )
      .then((data) => setOrder({ ...data, expiresAt: new Date(data.expiresAt) }))
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [reservationId, router]);

  const handleReservationExpired = (): void => {
    router.push(`/?expired=true`);
  };

  const handleProceedToPayment = (): void => {
    if (order?.checkoutUrl) {
      // Redirecionar para o Stripe Checkout (página hospedada pelo Stripe)
      window.location.href = order.checkoutUrl;
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
        <h1 className="text-2xl font-bold mb-4">Não foi possível criar o pedido</h1>
        <p className="text-gray-600 mb-6">{error}</p>
        <Button onClick={() => router.back()}>Voltar</Button>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Finalizar Compra</h1>

      {/* Countdown do tempo de reserva */}
      {order && (
        <ReservationTimer
          expiresAt={order.expiresAt}
          onExpired={handleReservationExpired}
          className="mb-6"
        />
      )}

      {/* Resumo do pedido */}
      {order && (
        <OrderSummary orderId={order.id} total={order.total} className="mb-6" />
      )}

      <Button
        className="w-full"
        size="lg"
        onClick={handleProceedToPayment}
        disabled={!order}
      >
        Pagar com Stripe
      </Button>

      <p className="text-xs text-gray-400 text-center mt-3">
        Você será redirecionado para a página segura do Stripe
      </p>
    </div>
  );
}
```

---

## Passo 12.2 — Reservation Timer Component

```typescript
// apps/web/src/components/checkout/reservation-timer.tsx
'use client';

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
}: ReservationTimerProps): JSX.Element {
  const [secondsLeft, setSecondsLeft] = useState(
    Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        clearInterval(interval);
        onExpired();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt, onExpired]);

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const isUrgent = secondsLeft < 120;  // menos de 2 minutos → vermelho

  return (
    <div className={cn(
      'flex items-center gap-3 p-4 rounded-xl border-2',
      isUrgent ? 'border-red-400 bg-red-50' : 'border-yellow-400 bg-yellow-50',
      className,
    )}>
      <div className={cn(
        'text-3xl font-mono font-bold',
        isUrgent ? 'text-red-600' : 'text-yellow-700',
      )}>
        {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
      </div>
      <div>
        <p className={cn('font-medium', isUrgent ? 'text-red-700' : 'text-yellow-800')}>
          {isUrgent ? '⚠️ Sua reserva está expirando!' : '⏱ Reserva temporária'}
        </p>
        <p className="text-sm text-gray-600">
          Complete o pagamento antes do tempo acabar
        </p>
      </div>
    </div>
  );
}
```

---

## Passo 12.3 — Success Page

```typescript
// apps/web/src/app/(buyer)/checkout/success/page.tsx

import { Suspense } from 'react';
import Link from 'next/link';
import { getOrderDetails } from '@/lib/api/payments';
import { Button } from '@/components/ui/button';

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: { order?: string };
}): Promise<JSX.Element> {
  const orderId = searchParams.order;

  return (
    <div className="container mx-auto px-4 py-16 text-center max-w-md">
      <div className="text-7xl mb-6">🎉</div>
      <h1 className="text-3xl font-bold mb-3">Pagamento confirmado!</h1>
      <p className="text-gray-600 mb-6">
        Seus ingressos serão enviados para o seu e-mail em alguns minutos.
      </p>

      <div className="flex flex-col gap-3">
        <Button asChild>
          <Link href="/my-tickets">Ver meus ingressos</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/">Explorar mais eventos</Link>
        </Button>
      </div>
    </div>
  );
}
```

---

## Testando na prática

Este é o fluxo mais crítico do produto: selecionar assentos → pagar → confirmar. Você vai percorrer o checkout completo no browser.

### O que precisa estar rodando

Todos os serviços dos caps anteriores **mais** o payment-service e a Stripe CLI:

```bash
# Infraestrutura + todos os serviços
docker compose up -d
pnpm --filter @showpass/auth-service run dev
pnpm --filter @showpass/event-service run dev
pnpm --filter @showpass/booking-service run dev
pnpm --filter @showpass/payment-service run dev
pnpm --filter @showpass/api-gateway run dev
pnpm --filter @showpass/web run dev

# Stripe CLI (em outro terminal)
stripe listen --forward-to http://localhost:3002/webhooks/stripe
```

### Passo a passo no browser

**1. Fazer login como comprador**

Acesse: **http://localhost:3001/login**

Use: `joao@email.com` / `MinhaSenha@123`

**2. Selecionar assentos e iniciar checkout**

Acesse: **http://localhost:3001/events/rock-in-rio-2025**

Selecione 2 assentos e clique em "Reservar". Você deve ser redirecionado para a página de checkout em `/checkout/[reservationId]`.

**3. Verificar o timer regressivo**

Na página de checkout, observe o timer de 15 minutos no canto superior. Ele exibe o tempo restante para completar o pagamento.

**4. Clicar em "Pagar com Stripe"**

Você será redirecionado para o Stripe Checkout (domínio `checkout.stripe.com`). Use o cartão de teste:

| Campo | Valor |
|---|---|
| Número | `4242 4242 4242 4242` |
| Validade | `12/26` |
| CVC | `123` |

**5. Verificar a página de sucesso**

Após confirmar o pagamento, o Stripe redireciona para: **http://localhost:3001/checkout/success?session_id=cs_test_...**

A página deve exibir:
- Confirmação do pedido com os assentos
- Mensagem de que os ingressos serão enviados por email
- CTA para ver "Meus Ingressos" ou explorar mais eventos

**6. Verificar que o assento foi bloqueado para outros**

Em outra aba (ou sessão anônima), acesse o mesmo evento. Os assentos que você comprou devem aparecer como indisponíveis (vermelho ou cinza escuro).

**7. Simular expiração da reserva**

Acesse a página de checkout mas **não** pague. Aguarde o timer zerar (ou reduza o TTL do Redis manualmente — veja Cap 06). Quando expirar, a página deve redirecionar automaticamente para `/checkout/cancel` com mensagem de reserva expirada.

**8. Testar pagamento recusado**

Use o cartão de teste de recusa do Stripe:

| Número | Comportamento |
|---|---|
| `4000 0000 0000 9995` | Fundos insuficientes |
| `4000 0000 0000 0002` | Cartão recusado |

O Stripe exibe a mensagem de erro na própria página de checkout. A reserva continua ativa até o TTL expirar.

---

## Recapitulando

1. **Stripe Checkout redirect** — segurança PCI máxima; página hospedada pelo Stripe
2. **Reservation Timer** — pressão visual de urgência; redireciona ao expirar
3. **Success page** — confirmação clara; CTA para ver ingressos ou explorar mais eventos
4. **Async ticket generation** — usuário é informado que recebe e-mail; sem esperar o PDF

---

## Próximo capítulo

[Capítulo 13 → Organizer Dashboard](cap-13-organizer-dashboard.md)
