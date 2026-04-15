# Capítulo 13 — Organizer Dashboard

> **Objetivo:** Dashboard do organizador com métricas em tempo real, gráficos de vendas com Recharts, e exportação de relatórios CSV.

## Passo 13.1 — Dashboard Page (Server Component)

```typescript
// apps/web/src/app/(organizer)/dashboard/page.tsx
//
// Server Component: busca dados pesados no servidor, renderiza HTML completo.
// Client Components apenas para gráficos interativos (Recharts precisa do DOM).

import { Suspense } from 'react';
import { apiRequest } from '@/lib/api-client';
import { z } from 'zod';
import { SalesChart } from '@/components/dashboard/sales-chart';
import { MetricCard } from '@/components/dashboard/metric-card';

const DashboardStatsSchema = z.object({
  totalRevenue: z.number(),
  totalTicketsSold: z.number(),
  activeEvents: z.number(),
  conversionRate: z.number(),
  revenueByDay: z.array(z.object({
    date: z.string(),
    revenue: z.number(),
    tickets: z.number(),
  })),
  topEvents: z.array(z.object({
    id: z.string(),
    title: z.string(),
    sold: z.number(),
    available: z.number(),
    revenue: z.number(),
  })),
});

export default async function DashboardPage(): Promise<JSX.Element> {
  const stats = await apiRequest('/events/dashboard/stats', DashboardStatsSchema);

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-8">Dashboard</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <MetricCard
          title="Receita Total"
          value={new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
            .format(stats.totalRevenue)}
          trend="+12% vs mês anterior"
          icon="💰"
        />
        <MetricCard
          title="Ingressos Vendidos"
          value={stats.totalTicketsSold.toLocaleString('pt-BR')}
          trend="+8% vs mês anterior"
          icon="🎟️"
        />
        <MetricCard
          title="Eventos Ativos"
          value={String(stats.activeEvents)}
          icon="🎪"
        />
        <MetricCard
          title="Conversão"
          value={`${stats.conversionRate.toFixed(1)}%`}
          trend="visualizações → compras"
          icon="📈"
        />
      </div>

      {/* Gráfico de vendas — Client Component */}
      <div className="bg-white rounded-2xl border p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold text-lg">Vendas por Dia</h2>
          <ExportCsvButton />
        </div>
        <Suspense fallback={<div className="h-64 animate-pulse bg-gray-100 rounded" />}>
          <SalesChart data={stats.revenueByDay} />
        </Suspense>
      </div>

      {/* Top Eventos */}
      <div className="bg-white rounded-2xl border p-6">
        <h2 className="font-semibold text-lg mb-4">Top Eventos</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="text-left py-2">Evento</th>
              <th className="text-right py-2">Vendidos</th>
              <th className="text-right py-2">Disponíveis</th>
              <th className="text-right py-2">Receita</th>
            </tr>
          </thead>
          <tbody>
            {stats.topEvents.map((event) => (
              <tr key={event.id} className="border-b last:border-0">
                <td className="py-3 font-medium">{event.title}</td>
                <td className="text-right py-3">{event.sold}</td>
                <td className="text-right py-3 text-gray-500">{event.available}</td>
                <td className="text-right py-3 font-medium text-green-600">
                  {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
                    .format(event.revenue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExportCsvButton(): JSX.Element {
  return (
    <a
      href="/api/dashboard/export.csv"
      download="relatorio.csv"
      className="text-sm text-blue-600 hover:underline"
    >
      Exportar CSV
    </a>
  );
}
```

---

## Passo 13.2 — Sales Chart (Recharts)

```typescript
// apps/web/src/components/dashboard/sales-chart.tsx
'use client';

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

export function SalesChart({ data }: { data: DayData[] }): JSX.Element {
  const formatted = data.map((d) => ({
    ...d,
    date: new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' })
      .format(new Date(d.date)),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={formatted}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
        <YAxis yAxisId="revenue" orientation="left" tick={{ fontSize: 12 }}
          tickFormatter={(v: number) => `R$${(v / 1000).toFixed(0)}k`} />
        <YAxis yAxisId="tickets" orientation="right" tick={{ fontSize: 12 }} />
        <Tooltip
          formatter={(value: number, name: string) => [
            name === 'revenue'
              ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value)
              : value,
            name === 'revenue' ? 'Receita' : 'Ingressos',
          ]}
        />
        <Legend />
        <Bar yAxisId="revenue" dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Receita" />
        <Line yAxisId="tickets" type="monotone" dataKey="tickets" stroke="#f97316" strokeWidth={2} name="Ingressos" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
```

---

## Passo 13.3 — CSV Export (Route Handler)

```typescript
// apps/web/src/app/api/dashboard/export.csv/route.ts
//
// Route Handler do Next.js — gera CSV no servidor e retorna como download.

import { NextResponse } from 'next/server';
import { apiRequest } from '@/lib/api-client';
import { z } from 'zod';

const OrdersExportSchema = z.array(z.object({
  orderId: z.string(),
  buyerEmail: z.string(),
  eventTitle: z.string(),
  total: z.number(),
  paidAt: z.string(),
  ticketCount: z.number(),
}));

export async function GET(): Promise<NextResponse> {
  const orders = await apiRequest('/payments/orders/export', OrdersExportSchema);

  const header = 'ID do Pedido,E-mail do Comprador,Evento,Total (R$),Data,Qtd. Ingressos\n';
  const rows = orders.map((o) =>
    [
      o.orderId,
      o.buyerEmail,
      `"${o.eventTitle.replace(/"/g, '""')}"`,  // escapar aspas no CSV
      o.total.toFixed(2).replace('.', ','),
      new Date(o.paidAt).toLocaleDateString('pt-BR'),
      o.ticketCount,
    ].join(','),
  );

  const csv = header + rows.join('\n');

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="relatorio-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
```

---

## Testando na prática

O dashboard de organizador é a visão de admin do produto. Você vai verificar as métricas de vendas, o gráfico e o export CSV.

### O que precisa estar rodando

```bash
docker compose up -d
pnpm --filter @showpass/auth-service run dev
pnpm --filter @showpass/event-service run dev
pnpm --filter @showpass/booking-service run dev
pnpm --filter @showpass/payment-service run dev
pnpm --filter @showpass/api-gateway run dev
pnpm --filter @showpass/web run dev
```

### Passo a passo no browser

**1. Fazer login como organizer**

Acesse: **http://localhost:3001/login**

Use: `admin@rockshows.com.br` / `Senha@Forte123`

**2. Acessar o dashboard**

Navegue para: **http://localhost:3001/dashboard**

Você deve ver:
- Cards com métricas: total de ingressos vendidos, receita total, eventos ativos
- Gráfico de barras/linhas com vendas ao longo do tempo
- Tabela de eventos com status e progresso de vendas

**3. Verificar que métricas chegam no HTML (Server Component)**

No DevTools → Network, recarregue a página. A request inicial ao `/dashboard` deve retornar o HTML já com os dados das métricas — não há loading states para as métricas principais. Isso é o PPR (Partial Prerendering) em ação.

**4. Exportar CSV de vendas**

Clique no botão "Exportar CSV". O browser deve baixar um arquivo `vendas-rock-in-rio-2025.csv` com as colunas:

```
id,buyerName,buyerEmail,seatRow,seatNumber,pricePaid,purchasedAt
```

**5. Verificar formatação em pt-BR**

Os valores monetários devem exibir `R$ 1.500,00` (ponto como separador de milhares, vírgula como decimal) — `Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })`.

As datas devem exibir no formato `26/09/2025` — `Intl.DateTimeFormat('pt-BR')`.

**6. Testar com outro organizer (isolamento de dados)**

Faça login com `outro@teste.com` e acesse o dashboard. Você **não** deve ver os eventos nem as métricas do `admin@rockshows.com.br`. Cada organizer vê apenas seus próprios dados.

**7. Verificar responsividade**

Redimensione o browser para largura de 375px (iPhone). O gráfico Recharts deve se adaptar e as métricas empilharem verticalmente.

---

## Recapitulando

1. **Server Component** para métricas pesadas — dados chegam no HTML, zero loading state
2. **Recharts `ComposedChart`** — barra (receita) + linha (ingressos) no mesmo gráfico
3. **CSV export** via Route Handler — gerado no servidor, sem expor a API key no cliente
4. **`Intl.NumberFormat` e `Intl.DateTimeFormat`** — formatação localizada (pt-BR) sem biblioteca

---

## Próximo capítulo

[Capítulo 14 → Testes](cap-14-testes.md)
