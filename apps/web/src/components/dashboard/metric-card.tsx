// apps/web/src/components/dashboard/metric-card.tsx
//
// Card de KPI do dashboard. Server-safe (sem hooks/estado) — renderiza no
// servidor junto com a página, sem custo de hidratação.

import type React from 'react';

interface MetricCardProps {
  title: string;
  value: string;
  icon: string;
  // Legenda secundária (ex: "estimativa bruta", "disponível no cap-17)
  trend?: string;
}

export function MetricCard({
  title,
  value,
  icon,
  trend,
}: MetricCardProps): React.JSX.Element {
  return (
    <div className="bg-white rounded-2xl border p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-500">{title}</span>
        <span className="text-xl" aria-hidden="true">
          {icon}
        </span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {trend && <p className="text-xs text-gray-400 mt-1">{trend}</p>}
    </div>
  );
}
