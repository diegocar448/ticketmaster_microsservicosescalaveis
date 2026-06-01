// apps/web/src/components/dashboard/sales-chart.tsx
//
// Client Component OBRIGATÓRIO: Recharts usa APIs do DOM (ResizeObserver, SVG).
// Importar Recharts num Server Component quebra em runtime.
'use client';

import type React from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
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
      <ComposedChart data={formatted}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
        <YAxis
          yAxisId="revenue"
          orientation="left"
          tick={{ fontSize: 12 }}
          tickFormatter={(v: number) => `R$${(v / 1000).toFixed(0)}k`}
        />
        <YAxis
          yAxisId="tickets"
          orientation="right"
          tick={{ fontSize: 12 }}
        />
        <Tooltip
          // Recharts 3: `value` é ValueType|undefined e `name` é o NOME da
          // série ("Receita"/"Ingressos"), não a dataKey. Formatamos receita
          // como BRL; ingressos como inteiro. O 2º item da tupla é o rótulo.
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
        <Legend />
        <Bar
          yAxisId="revenue"
          dataKey="revenue"
          fill="#3b82f6"
          radius={[4, 4, 0, 0]}
          name="Receita"
        />
        <Line
          yAxisId="tickets"
          type="monotone"
          dataKey="tickets"
          stroke="#f97316"
          strokeWidth={2}
          name="Ingressos"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
