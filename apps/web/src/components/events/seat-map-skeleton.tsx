// apps/web/src/components/events/seat-map-skeleton.tsx
//
// Fallback do <Suspense> enquanto o Client Component (event-page.client)
// hidrata. Mantém o mesmo esqueleto visual do painel lateral para evitar
// layout shift quando o componente real entra em cena.

import type React from 'react';

export function SeatMapSkeleton(): React.JSX.Element {
  return (
    <div className="bg-white rounded-2xl border p-6 sticky top-8 animate-pulse">
      <div className="h-6 w-2/3 bg-gray-200 rounded mb-4" />
      <div className="space-y-2 mb-4">
        <div className="h-12 bg-gray-100 rounded" />
        <div className="h-12 bg-gray-100 rounded" />
      </div>
      <div className="h-40 bg-gray-100 rounded mb-4" />
      <div className="h-12 bg-gray-200 rounded" />
    </div>
  );
}
