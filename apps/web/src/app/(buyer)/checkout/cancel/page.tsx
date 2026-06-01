// apps/web/src/app/(buyer)/checkout/cancel/page.tsx
//
// Servidor. Dois caminhos chegam aqui:
//   (a) usuário clica "Cancelar" na página do Stripe → Stripe redireciona
//   (b) timer da reserva expira no frontend → redirect programático
// Em ambos: ${FRONTEND_URL}/checkout/cancel?order=${orderId}.
// A reserva pode ainda estar válida por segundos quando o caso (a) acontece,
// por isso a copy é informativa, não definitiva.

import type React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

interface SearchParams {
  order?: string;
}

export default async function CheckoutCancelPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
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
        Se quiser os mesmos assentos, volte ao evento e tente reservar
        novamente. Após o TTL de 7 minutos os locks Redis são liberados
        automaticamente.
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
