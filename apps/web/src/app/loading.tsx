// apps/web/src/app/loading.tsx
//
// Loading UI GLOBAL do App Router. O Next renderiza isto automaticamente como
// fallback de Suspense durante a navegação para QUALQUER rota — do clique até a
// página (e seus dados no servidor) terminarem de carregar. É o padrão de
// loading para todas as telas: ex. ao ir de /login para /dashboard, o spinner
// roda até o dashboard (que busca as métricas no servidor) estar pronto.

import type React from 'react';
import { FullScreenLoader } from '@/components/loading-overlay';

export default function Loading(): React.JSX.Element {
  return <FullScreenLoader label="Carregando…" />;
}
