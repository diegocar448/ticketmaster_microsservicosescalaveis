'use client';

// apps/web/src/components/home-ver-eventos-button.tsx
//
// CTA da home para buyer já autenticado. Navega para /events/[slug] do
// primeiro evento disponível (via router.push). Mostra overlay durante
// a transição para evitar clique duplo — mesmo padrão do HomeEntrarButton.

import type React from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Ticket } from 'lucide-react';
import { LoadingOverlay } from '@/components/loading-overlay';

export function HomeVerEventosButton(): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const handleClick = (): void => {
    if (pending) return;
    setPending(true);
    router.push('/events');
  };

  return (
    <>
      <LoadingOverlay show={pending} />
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="mt-2 inline-flex h-12 items-center gap-2 rounded-full bg-linear-to-br from-blue-500 to-violet-500 px-9 text-sm font-semibold text-white shadow-lg shadow-blue-500/30 transition hover:from-blue-600 hover:to-violet-600 hover:shadow-blue-500/40 active:scale-[0.98] disabled:opacity-70"
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Ticket className="size-4" />
        )}
        Ver Eventos
      </button>
    </>
  );
}
