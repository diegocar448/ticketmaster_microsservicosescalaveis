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
import { DollarSign, Ticket, CalendarCheck2, TrendingUp } from 'lucide-react';
import { SalesChart } from '@/components/dashboard/sales-chart';
import { MetricCard } from '@/components/dashboard/metric-card';
import { EventsTable } from '@/components/dashboard/events-table';

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
      className="inline-flex h-9 items-center rounded-full border px-4 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
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
    <div className="space-y-5">
      {/* Banner com gradiente de marca — elemento-assinatura do Horizon UI */}
      <div className="relative overflow-hidden rounded-3xl bg-linear-to-br from-brand-400 via-brand-500 to-brand-700 p-6 text-white shadow-card sm:p-8">
        <div className="absolute -top-10 -right-10 size-40 rounded-full bg-white/10" />
        <div className="absolute -bottom-16 right-24 size-40 rounded-full bg-white/5" />
        <h1 className="relative text-2xl font-bold tracking-tight">
          Bem-vindo ao painel ShowPass 👋
        </h1>
        <p className="relative mt-1 max-w-md text-sm text-white/80">
          Acompanhe vendas, ingressos e receita dos seus eventos em tempo real.
        </p>
        <a
          href="/events/create"
          className="relative mt-4 inline-flex h-10 items-center rounded-full bg-white px-5 text-sm font-semibold text-brand-600 shadow-sm transition hover:bg-white/90"
        >
          Criar evento
        </a>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Receita Total"
          value={brl.format(stats.totalRevenue)}
          trend="estimativa bruta"
          icon={DollarSign}
          accentClass="bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400"
        />
        <MetricCard
          title="Ingressos Vendidos"
          value={stats.totalTicketsSold.toLocaleString('pt-BR')}
          icon={Ticket}
          accentClass="bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400"
        />
        <MetricCard
          title="Eventos Ativos"
          value={String(stats.activeEvents)}
          icon={CalendarCheck2}
          accentClass="bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"
        />
        <MetricCard
          title="Conversão"
          value="—"
          trend="disponível no cap-17"
          icon={TrendingUp}
          accentClass="bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
        />
      </div>

      <div className="rounded-3xl border bg-card p-6 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Vendas por Dia</h2>
          <ExportCsvButton />
        </div>
        <Suspense
          fallback={
            <div className="h-[300px] animate-pulse rounded-2xl bg-muted" />
          }
        >
          <SalesChart data={stats.revenueByDay} />
        </Suspense>
      </div>

      <div className="rounded-3xl border bg-card p-6 shadow-card">
        <h2 className="mb-4 text-lg font-semibold">Top Eventos</h2>
        <EventsTable data={stats.topEvents} />
      </div>
    </div>
  );
}
