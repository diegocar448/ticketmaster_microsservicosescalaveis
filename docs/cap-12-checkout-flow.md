# Capítulo 12 — Checkout Flow

> **Objetivo:** Implementar o fluxo de checkout com redirect para o Stripe Checkout, countdown do tempo de reserva (baseado no TTL real da reserva), resumo do pedido derivado da reserva, e páginas de sucesso e cancelamento.

## O que você vai aprender

- Como consumir `POST /payments/orders` (retorna `{ orderId, checkoutUrl, status }`) e em seguida buscar o `expiresAt` real via `GET /bookings/reservations/:id`
- Por que o timer de 7 minutos vem da reserva, não da order
- Redirect puro para o Stripe Checkout (sem Stripe Elements nem `loadStripe`)
- Server Components no Next.js 16 com `searchParams` como Promise
- Página `/checkout/cancel` para o fluxo de cancelamento e expiração

---

## Passo 12.1 — Checkout Page

O fluxo tem duas chamadas em sequência:

1. `POST /payments/orders` → cria a order e devolve a `checkoutUrl` do Stripe
2. `GET /bookings/reservations/:id` → busca `expiresAt` e os itens (preço, quantidade, nome do lote) para montar o resumo

O payment-service deliberadamente **não** devolve `expiresAt` — a verdade do TTL vive no lock Redis gerenciado pelo booking-service (cap-06). Buscar da reserva garante que o countdown esteja sempre sincronizado com o lock real.

```typescript
// apps/web/src/app/(buyer)/checkout/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api-client';
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

export default function CheckoutPage() {
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

    async function init() {
      // Passo 1: criar a order → payment-service retorna { orderId, checkoutUrl, status }.
      // Não tem `total` nem `expiresAt` — esses dados ficam na reserva.
      const order = await apiRequest(
        '/payments/orders',
        CreateOrderResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({ reservationIds: [reservationId] }),
        },
      );

      // Passo 2: buscar a reserva para obter expiresAt (fonte do countdown)
      // e os itens enriquecidos (nome do lote, preço unitário, quantidade).
      // O booking-service é quem gerencia o lock Redis de 7 min — só ele
      // sabe quando o tempo realmente acaba.
      const reservation = await apiRequest(
        `/bookings/reservations/${reservationId}`,
        ReservationResponseSchema,
      );

      setCheckout({ orderId: order.orderId, checkoutUrl: order.checkoutUrl, reservation });
    }

    init()
      .catch((err: Error) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [reservationId, router]);

  const handleReservationExpired = () => {
    // Expirou sem pagamento → leva para a página de cancelamento com o orderId
    // para que o usuário saiba qual pedido ficou pendente
    router.push(`/checkout/cancel?order=${checkout?.orderId ?? ''}`);
  };

  const handleProceedToPayment = () => {
    if (checkout?.checkoutUrl) {
      // Redirect puro para a página hospedada pelo Stripe (domínio checkout.stripe.com).
      // Sem Stripe Elements: toda a coleta de dados do cartão é responsabilidade
      // do Stripe — máxima conformidade PCI com zero código extra no frontend.
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
        <h1 className="text-2xl font-bold mb-4">Não foi possível criar o pedido</h1>
        <p className="text-gray-600 mb-6">{error}</p>
        <Button onClick={() => router.back()}>Voltar</Button>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Finalizar Compra</h1>

      {/* Countdown alimentado pelo expiresAt da RESERVA (TTL = 7 min = 420s) */}
      {checkout && (
        <ReservationTimer
          expiresAt={checkout.reservation.expiresAt}
          onExpired={handleReservationExpired}
          className="mb-6"
        />
      )}

      {/* Resumo derivado dos itens da reserva */}
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
```

---

## Passo 12.2 — Reservation Timer Component

O `expiresAt` vem da reserva (passo anterior). O timer é puramente visual — o lock Redis expira no backend independentemente; a expiração aqui apenas antecipa o redirect para o usuário.

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
}: ReservationTimerProps) {
  const [secondsLeft, setSecondsLeft] = useState(
    Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        clearInterval(interval);
        // Dispara o callback: a CheckoutPage redireciona para /checkout/cancel
        onExpired();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt, onExpired]);

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  // Menos de 2 minutos → feedback visual urgente para pressionar o usuário a agir
  const isUrgent = secondsLeft < 120;

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
          7 minutos para concluir o pagamento (TTL do lock Redis)
        </p>
      </div>
    </div>
  );
}
```

---

## Passo 12.3 — Order Summary Component

O resumo é calculado a partir dos itens da reserva (`ReservationResponseSchema.items`). O valor mostrado é o **subtotal estimado** (soma de `unitPrice × quantity`). O total autoritativo — com taxa de serviço e impostos — está na página do Stripe Checkout; não inventamos um endpoint só para isso.

```typescript
// apps/web/src/components/checkout/order-summary.tsx

import { cn } from '@/lib/utils';
import { type ReservationResponse } from '@showpass/types';

interface OrderSummaryProps {
  reservation: ReservationResponse;
  className?: string;
}

// Formata centavos → R$ X,XX (os preços trafegam como centavos inteiros)
function formatBRL(cents: number) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export function OrderSummary({ reservation, className }: OrderSummaryProps) {
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
              {item.quantity > 1 ? ` × ${item.quantity}` : ''}
            </span>
            <span className="font-medium">{formatBRL(item.unitPrice * item.quantity)}</span>
          </li>
        ))}
      </ul>

      <div className="border-t pt-3 flex justify-between font-semibold">
        <span>Subtotal</span>
        <span>{formatBRL(subtotal)}</span>
      </div>

      {/* O Stripe adiciona a taxa de serviço e impostos — o total final
          aparecerá na própria página de checkout do Stripe */}
      <p className="text-xs text-gray-400 mt-2">
        Taxas e encargos serão exibidos na página de pagamento do Stripe.
      </p>
    </div>
  );
}
```

---

## Passo 12.4 — Success Page

Server Component. No Next.js 16, `searchParams` é uma **Promise** — é obrigatório usar `await` antes de acessar qualquer propriedade.

O Stripe redireciona para `${FRONTEND_URL}/checkout/success?order=${orderId}` (parâmetro `order`, não `session_id` — a session fica encapsulada no payment-service via webhook).

```typescript
// apps/web/src/app/(buyer)/checkout/success/page.tsx

import Link from 'next/link';
import { Button } from '@/components/ui/button';

interface SearchParams {
  order?: string;
}

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  // Next.js 16: searchParams é Promise — sempre aguardar antes de desestruturar
  searchParams: Promise<SearchParams>;
}) {
  const { order: orderId } = await searchParams;

  return (
    <div className="container mx-auto px-4 py-16 text-center max-w-md">
      <div className="text-7xl mb-6">🎉</div>
      <h1 className="text-3xl font-bold mb-3">Pagamento confirmado!</h1>

      {orderId && (
        <p className="text-sm text-gray-400 mb-2">Pedido: {orderId}</p>
      )}

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

## Passo 12.5 — Cancel Page

Criada para dois cenários: (a) o usuário clica em "Cancelar" na página do Stripe; (b) o timer da reserva expira e o frontend redireciona programaticamente. Em ambos os casos o Stripe (ou o próprio frontend) envia para `${FRONTEND_URL}/checkout/cancel?order=${orderId}`.

A reserva pode ainda estar válida por alguns segundos quando o usuário chega aqui via "Cancelar" no Stripe — por isso a mensagem é informativa, não definitiva.

```typescript
// apps/web/src/app/(buyer)/checkout/cancel/page.tsx

import Link from 'next/link';
import { Button } from '@/components/ui/button';

interface SearchParams {
  order?: string;
}

export default async function CheckoutCancelPage({
  searchParams,
}: {
  // Next.js 16: searchParams é Promise — await obrigatório
  searchParams: Promise<SearchParams>;
}) {
  const { order: orderId } = await searchParams;

  return (
    <div className="container mx-auto px-4 py-16 text-center max-w-md">
      <div className="text-7xl mb-6">⏳</div>
      <h1 className="text-3xl font-bold mb-3">Pagamento não concluído</h1>

      {orderId && (
        <p className="text-sm text-gray-400 mb-2">Pedido: {orderId}</p>
      )}

      <p className="text-gray-600 mb-2">
        Sua reserva pode ainda estar válida por alguns minutos.
      </p>
      <p className="text-gray-500 text-sm mb-6">
        Se quiser os mesmos assentos, volte ao evento e tente reservar novamente.
        Após o TTL de 7 minutos os locks Redis são liberados automaticamente.
      </p>

      <div className="flex flex-col gap-3">
        <Button asChild>
          <Link href="/">Explorar eventos</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/my-tickets">Ver meus ingressos</Link>
        </Button>
      </div>
    </div>
  );
}
```

---

## Testando na prática

Este é o fluxo mais crítico do produto: selecionar assentos → criar order → pagar no Stripe → confirmar. Você vai percorrer o checkout completo no browser.

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

# Stripe CLI — encaminha webhooks do Stripe para o payment-service local
stripe listen --forward-to http://localhost:3002/webhooks/stripe
```

### Passo a passo no browser

**1. Fazer login como comprador**

Acesse: **http://localhost:3001/login**

Use: `diego@email.com` / `MinhaSenha@123`

**2. Selecionar assentos e iniciar checkout**

Acesse: **http://localhost:3001/events/$EVENT_SLUG** (use o slug gerado no cap-05 — inclui timestamp).

Selecione 2 assentos e clique em "Reservar". Você deve ser redirecionado para `/checkout?reservation=$RESERVATION_ID`.

**3. Verificar as duas chamadas de rede**

Abra o DevTools → Network. Você verá:

- `POST /payments/orders` → `{ orderId, checkoutUrl, status: "pending" }`
- `GET /bookings/reservations/$RESERVATION_ID` → `{ ..., expiresAt: "...", items: [...] }`

**4. Verificar o timer regressivo**

O timer deve aparecer em **07:00** decrescendo (TTL = `SEAT_LOCK_TTL_SECONDS=420`). Ele exibe o tempo restante para completar o pagamento e está sincronizado com o lock Redis do booking-service (cap-06).

**5. Clicar em "Pagar com Stripe"**

Você será redirecionado para o Stripe Checkout (domínio `checkout.stripe.com`). Use o cartão de teste:

| Campo | Valor |
|---|---|
| Número | `4242 4242 4242 4242` |
| Validade | `12/26` |
| CVC | `123` |

**6. Verificar a página de sucesso**

Após confirmar o pagamento, o Stripe redireciona para:
**http://localhost:3001/checkout/success?order=$ORDER_ID**

A página deve exibir a confirmação com o `orderId` e a mensagem de que os ingressos serão enviados por email.

**7. Verificar que os assentos foram bloqueados para outros**

Em outra aba (ou sessão anônima), acesse o mesmo evento. Os assentos comprados devem aparecer como indisponíveis (vermelho ou cinza escuro).

**8. Simular expiração da reserva**

Acesse `/checkout?reservation=$RESERVATION_ID` mas **não** pague. Aguarde o timer zerar (ou reduza o TTL do Redis manualmente — veja Cap-06). Quando expirar, a página redireciona automaticamente para `/checkout/cancel?order=$ORDER_ID` com a mensagem "Pagamento não concluído".

**9. Testar cancelamento pelo Stripe**

Na página do Stripe Checkout, clique em "Cancelar". O Stripe redireciona para:
**http://localhost:3001/checkout/cancel?order=$ORDER_ID**

**10. Testar pagamento recusado**

Use os cartões de teste de erro do Stripe:

| Número | Comportamento |
|---|---|
| `4242 4242 4242 4242` | Aprovado |
| `4000 0000 0000 0002` | Cartão recusado |
| `4000 0000 0000 9995` | Fundos insuficientes |

O Stripe exibe a mensagem de erro na própria página de checkout. A reserva continua ativa até o TTL expirar.

---

## Recapitulando

1. **Duas chamadas em sequência** — `POST /payments/orders` cria a order; `GET /bookings/reservations/:id` traz o `expiresAt` real e os itens para o resumo
2. **Fonte única de verdade do TTL** — o countdown vem da reserva (lock Redis de 7 min), não da order
3. **Redirect puro para o Stripe** — sem Stripe Elements; conformidade PCI máxima com mínimo de código
4. **`searchParams` como Promise** — obrigatório no Next.js 16; ambas as Server Pages usam `await searchParams`
5. **Página `/checkout/cancel`** — cobre dois cenários: usuário cancela no Stripe e timer expira no frontend
6. **Async ticket generation** — usuário é informado que recebe e-mail; sem aguardar a geração do PDF

---

## Próximo capítulo

[Capítulo 13 → Organizer Dashboard](cap-13-organizer-dashboard.md)
