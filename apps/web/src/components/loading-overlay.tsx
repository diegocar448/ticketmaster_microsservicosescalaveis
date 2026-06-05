// apps/web/src/components/loading-overlay.tsx
//
// Loader full-screen padrão do app. Dois usos:
//   - <FullScreenLoader/>  → em loading.tsx e fallbacks de Suspense (Next mostra
//     automaticamente DO clique até a rota terminar de carregar).
//   - <LoadingOverlay show/> → durante uma ação client-side (ex.: submit do login),
//     cobrindo a tela e impedindo clique duplo.
//
// fixed inset-0 + z alto: captura todos os cliques → o botão por baixo não pode
// ser clicado de novo (sem requisição duplicada).

import type React from 'react';
import { Loader2 } from 'lucide-react';

export function FullScreenLoader({
  label,
}: {
  label?: string;
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-[#0a0a0f]/90 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <Loader2 className="size-10 animate-spin text-blue-400" />
      {label ? <p className="text-sm text-slate-300">{label}</p> : null}
      <span className="sr-only">Carregando…</span>
    </div>
  );
}

export function LoadingOverlay({
  show,
  label,
}: {
  show: boolean;
  label?: string;
}): React.JSX.Element | null {
  if (!show) return null;
  // exactOptionalPropertyTypes: não passar label={undefined} — omitir a prop.
  return <FullScreenLoader {...(label !== undefined ? { label } : {})} />;
}
