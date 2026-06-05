'use client';

// apps/web/src/components/header.tsx
//
// Header global: marca + alternador de tema + estado de autenticação.
// Lê o auth-store (Zustand/persist). Como o store só hidrata no cliente,
// o bloco de auth fica atrás de um gate `mounted` para não divergir do SSR
// (servidor sempre renderiza "deslogado").

import type React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { ThemeToggle } from '@/components/theme-toggle';

// O Header global some onde há chrome próprio: painel do organizer (sidebar) e
// a tela de login (imersiva "Neural Access").
const HIDE_HEADER_PREFIXES = [
  '/dashboard',
  '/events/create',
  '/events/edit',
  '/login',
];

export function Header(): React.JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logout = useAuthStore((s) => s.logout);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Home ('/') e telas imersivas (login, painel) não mostram o Header global —
  // a home tem só o CTA "Entrar" do hero.
  if (pathname === '/' || HIDE_HEADER_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null;
  }

  const authed = mounted && isAuthenticated();

  const handleLogout = (): void => {
    logout();
    // refresh() revalida Server Components que liam o cookie access_token.
    router.push('/');
    router.refresh();
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="text-lg font-bold">
          ShowPass
        </Link>

        <div className="flex items-center gap-3">
          <ThemeToggle />

          {/* Até montar, não renderiza o estado de auth (evita flash/mismatch). */}
          {!mounted ? (
            <span className="h-9 w-16" />
          ) : authed ? (
            <>
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {user?.email}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium transition hover:bg-accent"
              >
                Sair
              </button>
            </>
          ) : (
            <Link
              href="/login"
              className="inline-flex h-9 items-center rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700"
            >
              Entrar
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
