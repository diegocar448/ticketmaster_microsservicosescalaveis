// apps/web/src/app/(buyer)/checkout/success/page.tsx
//
// Server Component. Next.js 16: `searchParams` é Promise — `await` obrigatório
// antes de desestruturar. O Stripe redireciona para
//   ${FRONTEND_URL}/checkout/success?order=${orderId}
// (parâmetro `order`, não `session_id` — a session fica encapsulada no
// payment-service via webhook).

import type React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

interface SearchParams {
  order?: string;
}

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
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
