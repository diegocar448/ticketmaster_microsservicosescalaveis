// apps/web/src/app/(organizer)/dashboard/page.tsx
//
// Server Component: busca as métricas no servidor e entrega o HTML completo
// (KPIs e tabela já no first paint, zero loading state). Apenas o gráfico
// Recharts é Client Component (precisa do DOM).
//
// O token vem do cookie access_token (via apiRequestServer) — Server Components
// não enxergam o Zustand/localStorage. O middleware Edge já garante que só
// organizers autenticados chegam aqui.

import type React from 'react';
import { Suspense } from 'react';
import { z } from 'zod';
import { apiRequestServer } from '@/lib/api-server';
import { SalesChart } from '@/components/dashboard/sales-chart';
import { MetricCard } from '@/components/dashboard/metric-card';

// Schema espelha exatamente o DashboardStats do event-service.
const DashboardStatsSchema = z.object({
  totalRevenue: z.number(),
  totalTicketsSold: z.number(),
  activeEvents: z.number(),
  conversionRate: z.number(),
  revenueByDay: z.array(
    z.object({
      date: z.string(),
      revenue: z.number(),
      tickets: z.number(),
    }),
  ),
  topEvents: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      sold: z.number(),
      available: z.number(),
      revenue: z.number(),
    }),
  ),
});

const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

// Link de download — não precisa de JS, fica como Server Component.
function ExportCsvButton(): React.JSX.Element {
  // Sem ".csv" no path: segmentos com ponto colidem com extensões estáticas
  // no Next. Usamos /api/dashboard/export + Content-Disposition no handler.
  return (
    <a
      href="/api/dashboard/export"
      download
      className="text-sm text-blue-600 hover:underline"
    >
      Exportar CSV
    </a>
  );
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const stats = await apiRequestServer(
    '/events/dashboard/stats',
    DashboardStatsSchema,
  );

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-8">Dashboard</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <MetricCard
          title="Receita Total"
          value={brl.format(stats.totalRevenue)}
          trend="estimativa bruta"
          icon="💰"
        />
        <MetricCard
          title="Ingressos Vendidos"
          value={stats.totalTicketsSold.toLocaleString('pt-BR')}
          icon="🎟️"
        />
        <MetricCard
          title="Eventos Ativos"
          value={String(stats.activeEvents)}
          icon="🎪"
        />
        <MetricCard
          title="Conversão"
          value="—"
          trend="disponível no cap-17"
          icon="📈"
        />
      </div>

      <div className="bg-white rounded-2xl border p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold text-lg">Vendas por Dia</h2>
          <ExportCsvButton />
        </div>
        <Suspense
          fallback={<div className="h-64 animate-pulse bg-gray-100 rounded" />}
        >
          <SalesChart data={stats.revenueByDay} />
        </Suspense>
      </div>

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
                <td className="text-right py-3 text-gray-500">
                  {event.available}
                </td>
                <td className="text-right py-3 font-medium text-green-600">
                  {brl.format(event.revenue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
