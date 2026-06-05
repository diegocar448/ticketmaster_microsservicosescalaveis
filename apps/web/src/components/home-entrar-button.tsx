'use client';

// apps/web/src/components/home-entrar-button.tsx
//
// CTA "Entrar" da home. Ao clicar: trava (pending), mostra o overlay de loading
// e navega para /login. O overlay cobre a tela e impede clique duplo durante a
// transição de rota (que pode levar um instante, sobretudo no 1º load em dev).

import type React from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { LoadingOverlay } from '@/components/loading-overlay';

export function HomeEntrarButton(): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const handleClick = (): void => {
    if (pending) return; // guarda contra clique duplo
    setPending(true);
    router.push('/login');
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
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Entrar
      </button>
    </>
  );
}
