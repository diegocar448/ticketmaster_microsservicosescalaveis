'use client';

// apps/web/src/components/dashboard/logout-button.tsx
//
// Botão de logout do topbar. Ao clicar: limpa auth-store + cookie, ativa o
// overlay de loading e navega para /. O overlay fica visível até o componente
// desmontar (quando a home carregar). Mesmo padrão do login: navigating state
// que nunca volta a false — o componente some com ele.

import type React from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { LoadingOverlay } from '@/components/loading-overlay';

export function LogoutButton(): React.JSX.Element {
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);
  const [navigating, setNavigating] = useState(false);

  const handleLogout = (): void => {
    if (navigating) return;
    logout();
    setNavigating(true);
    router.push('/');
    router.refresh();
  };

  return (
    <>
      <LoadingOverlay show={navigating} label="Saindo…" />
      <button
        type="button"
        onClick={handleLogout}
        disabled={navigating}
        aria-label="Sair"
        className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium transition hover:bg-accent disabled:opacity-60"
      >
        {navigating ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <LogOut className="size-4" />
        )}
        <span className="hidden sm:inline">Sair</span>
      </button>
    </>
  );
}
