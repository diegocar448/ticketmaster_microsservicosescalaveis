// apps/web/src/components/dashboard/metric-card.tsx
//
// Card de KPI estilo Horizon UI: ícone num badge arredondado colorido + rótulo
// + valor grande. Server-safe (sem hooks). Cores via tokens shadcn (dark-aware).

import type React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MetricCardProps {
  title: string;
  value: string;
  icon: LucideIcon;
  // Classes do badge do ícone (bg + text), passadas pela página — dark-aware.
  accentClass?: string;
  // Legenda secundária (ex: "estimativa bruta").
  trend?: string;
}

export function MetricCard({
  title,
  value,
  icon: Icon,
  accentClass = 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400',
  trend,
}: MetricCardProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 rounded-3xl border bg-card p-5 shadow-card transition-shadow hover:shadow-lg">
      <div
        className={cn(
          'flex size-12 shrink-0 items-center justify-center rounded-2xl',
          accentClass,
        )}
      >
        <Icon className="size-6" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm text-muted-foreground">{title}</p>
        <p className="text-2xl font-bold tracking-tight">{value}</p>
        {trend ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground/70">
            {trend}
          </p>
        ) : null}
      </div>
    </div>
  );
}
