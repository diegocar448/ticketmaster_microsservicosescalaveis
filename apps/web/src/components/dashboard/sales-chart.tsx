// apps/web/src/components/dashboard/sales-chart.tsx
//
// Client Component OBRIGATÓRIO: Recharts usa APIs do DOM (ResizeObserver, SVG).
// Importar Recharts num Server Component quebra em runtime.
//
// Estilo Horizon UI: áreas suaves com gradiente, grid discreto, eixos via tokens
// (dark-aware). Receita (indigo) no eixo esquerdo, ingressos (violeta) no direito.
'use client';

import type React from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

interface DayData {
  date: string;
  revenue: number;
  tickets: number;
}

export function SalesChart({ data }: { data: DayData[] }): React.JSX.Element {
  const formatted = data.map((d) => ({
    ...d,
    // "YYYY-MM-DD" → "26 set" (mais legível no eixo X).
    // T00:00:00 força hora local, não UTC (evita deslocar 1 dia).
    date: new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: 'short',
    }).format(new Date(`${d.date}T00:00:00`)),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={formatted} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <defs>
          <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.35} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="fillTickets" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#a855f7" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid
          vertical={false}
          strokeDasharray="3 3"
          stroke="var(--border)"
        />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
        />
        <YAxis
          yAxisId="revenue"
          orientation="left"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
          tickFormatter={(v: number) => `R$${(v / 1000).toFixed(0)}k`}
        />
        <YAxis
          yAxisId="tickets"
          orientation="right"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
        />
        <Tooltip
          contentStyle={{
            borderRadius: 12,
            border: '1px solid var(--border)',
            background: 'var(--popover)',
            color: 'var(--popover-foreground)',
            fontSize: 12,
          }}
          // Recharts 3: `value` é ValueType|undefined e `name` é o NOME da
          // série ("Receita"/"Ingressos"). Formatamos receita como BRL.
          formatter={(value, name) => {
            const num = typeof value === 'number' ? value : Number(value ?? 0);
            return [
              name === 'Receita'
                ? new Intl.NumberFormat('pt-BR', {
                    style: 'currency',
                    currency: 'BRL',
                  }).format(num)
                : num,
              name,
            ];
          }}
        />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
        />
        <Area
          yAxisId="revenue"
          type="monotone"
          dataKey="revenue"
          name="Receita"
          stroke="#6366f1"
          strokeWidth={2.5}
          fill="url(#fillRevenue)"
        />
        <Area
          yAxisId="tickets"
          type="monotone"
          dataKey="tickets"
          name="Ingressos"
          stroke="#a855f7"
          strokeWidth={2.5}
          fill="url(#fillTickets)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
