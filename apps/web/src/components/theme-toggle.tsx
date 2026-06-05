'use client';

// apps/web/src/components/theme-toggle.tsx
//
// Alterna entre tema claro e escuro. O estado real vive na classe `.dark` do
// <html> (aplicada antes da hidratação pelo script no-flash em layout.tsx) e é
// persistido em localStorage. Default: dark.

import type React from 'react';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'showpass-theme';

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function ThemeToggle(): React.JSX.Element {
  // mounted evita mismatch de hidratação: no SSR não sabemos o tema do cliente.
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(readTheme());
    setMounted(true);
  }, []);

  const toggle = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage indisponível (modo privado) — tema só nesta sessão.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={
        theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'
      }
      title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground transition hover:bg-accent"
    >
      {/* Antes de montar, render neutro p/ não divergir do HTML do servidor. */}
      {!mounted ? (
        <span className="block h-4 w-4" />
      ) : theme === 'dark' ? (
        // Sol (clicar → vai para claro)
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        // Lua (clicar → vai para escuro)
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
