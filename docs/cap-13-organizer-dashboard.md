# Capítulo 13 — Organizer Dashboard

> **Objetivo:** Dashboard do organizador com métricas em tempo real, gráficos de vendas com Recharts, e exportação de relatórios CSV.

---

## Passo 13.1 — Endpoint de métricas no event-service

Antes de construir qualquer frontend, precisamos de um endpoint que sirva os dados. O dashboard precisa de métricas agregadas sobre eventos e ingressos — e **esses dados vivem no banco do event-service**.

> **Por que não criar um serviço agregador?**
> A tentação em microsserviços é criar um "analytics-service" que chama os outros. Isso introduz acoplamento síncrono em tempo de request: se o payment-service estiver lento, o dashboard trava. A regra do projeto é clara — cada serviço acessa **apenas o seu próprio banco**. O event-service já tem `soldCount`, `reservedCount`, `totalCapacity` na tabela `events` e os campos `price`, `soldCount`, `totalQuantity` na `ticket_batches`. São dados suficientes para um dashboard operacional.

### A query Prisma

Adicione o método `getDashboardStats` no repositório existente:

```typescript
// apps/event-service/src/modules/events/events.repository.ts
// (adicionar abaixo de listByOrganizer)

// ─── Tipos do dashboard ───────────────────────────────────────────────────────

export type DashboardStats = {
  totalRevenue: number;
  totalTicketsSold: number;
  activeEvents: number;
  conversionRate: number;  // sempre 0 — ver comentário no método
  revenueByDay: Array<{ date: string; revenue: number; tickets: number }>;
  topEvents: Array<{
    id: string;
    title: string;
    sold: number;
    available: number;
    revenue: number;
  }>;
};
```

Ainda no `events.repository.ts`, adicione dentro da classe `EventsRepository`:

```typescript
  /**
   * Agrega métricas do organizer a partir de eventos e lotes de ingressos.
   *
   * Por que calcular aqui e não no banco?
   *   groupBy do Prisma não suporta cálculos com colunas de tabelas relacionadas
   *   num único aggregate. Trazer os lotes e computar em JS é aceitável para
   *   o volume de eventos de um único organizer (dezenas/centenas, não milhões).
   *
   * TRADE-OFFS HONESTOS:
   *
   * 1. totalRevenue como "estimativa de receita bruta":
   *    Calculamos Σ(soldCount × price) nos lotes do event-service.
   *    Isso é uma estimativa — a fonte financeira autoritativa é o payment-service,
   *    que tem os registros reais de pagamento com status confirmado pelo Stripe.
   *    Divergências ocorrem por: cupons, reembolsos, estornos, taxas.
   *    Reconciliação fina entre event-service e payment-service fica para o
   *    cap-18 (analytics real com tabela de eventos de domínio).
   *
   * 2. revenueByDay como "dados ilustrativos":
   *    O event-service não tem tabela de transações diárias. Aproximamos
   *    distribuindo receita por dia de criação do evento. Isso não reflete
   *    o dia em que cada ingresso foi vendido. Uma solução real exige um
   *    event log de vendas, implementado no cap-18.
   *
   * 3. conversionRate sempre 0:
   *    Taxa de conversão = vendas / visualizações de página. Views não
   *    são rastreadas ainda. O cap-17 (observabilidade) adiciona tracking
   *    de métricas com OpenTelemetry + Grafana. Retornamos 0 com tipagem
   *    correta para não quebrar o schema do frontend.
   */
  async getDashboardStats(organizerId: string): Promise<DashboardStats> {
    // Buscar todos os eventos do organizer com seus lotes
    // Sem paginação — o volume de eventos de um organizer é pequeno
    const events = await this.prisma.event.findMany({
      where: { organizerId },  // tenant isolation: sempre filtrar por organizerId
      include: {
        ticketBatches: {
          where: { isVisible: true },
          select: {
            price: true,
            soldCount: true,
            totalQuantity: true,
            reservedCount: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,  // limite defensivo — edge case de organizers com muitos eventos
    });

    // ── Totais globais ────────────────────────────────────────────────────────

    let totalRevenue = 0;
    let totalTicketsSold = 0;

    for (const event of events) {
      for (const batch of event.ticketBatches) {
        // Decimal do Prisma — converter para number explicitamente
        const price = Number(batch.price);
        totalRevenue += batch.soldCount * price;
        totalTicketsSold += batch.soldCount;
      }
    }

    // ── Eventos ativos ────────────────────────────────────────────────────────

    const activeEvents = events.filter(
      (e) => e.status === 'published' || e.status === 'on_sale',
    ).length;

    // ── revenueByDay — últimos 30 dias ────────────────────────────────────────
    //
    // Aproximação: atribuímos a receita total do evento ao dia de sua criação.
    // Isso não reflete o dia real das vendas (sem tabela de transações aqui).
    // Marcado como dado ilustrativo — substituído por analytics real no cap-18.

    const revenueMap = new Map<string, { revenue: number; tickets: number }>();

    // Pré-popular últimos 30 dias com zeros (garante que o gráfico não tenha lacunas)
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);  // "YYYY-MM-DD"
      revenueMap.set(key, { revenue: 0, tickets: 0 });
    }

    for (const event of events) {
      const key = event.createdAt.toISOString().slice(0, 10);
      if (!revenueMap.has(key)) continue;  // fora da janela de 30 dias

      const entry = revenueMap.get(key)!;
      for (const batch of event.ticketBatches) {
        const price = Number(batch.price);
        entry.revenue += batch.soldCount * price;
        entry.tickets += batch.soldCount;
      }
    }

    const revenueByDay = Array.from(revenueMap.entries()).map(([date, v]) => ({
      date,
      revenue: v.revenue,
      tickets: v.tickets,
    }));

    // ── Top eventos por soldCount ──────────────────────────────────────────────

    const topEvents = events
      .map((event) => {
        const sold = event.soldCount;
        const available = event.totalCapacity - event.soldCount - event.reservedCount;
        const revenue = event.ticketBatches.reduce(
          (sum, b) => sum + b.soldCount * Number(b.price),
          0,
        );
        return { id: event.id, title: event.title, sold, available, revenue };
      })
      .sort((a, b) => b.sold - a.sold)
      .slice(0, 10);  // top 10 — suficiente para exibição em tabela

    return {
      totalRevenue,
      totalTicketsSold,
      activeEvents,
      conversionRate: 0,  // real no cap-17 (OpenTelemetry + views tracking)
      revenueByDay,
      topEvents,
    };
  }
```

### O service

Adicione o método delegando ao repositório:

```typescript
// apps/event-service/src/modules/events/events.service.ts
// (adicionar abaixo de listByOrganizer)

  /**
   * Métricas agregadas para o dashboard do organizer.
   * Sem cache Redis — dados mudam a cada venda/reserva.
   * Se a latência virar problema: cache com TTL de 60s (aceitável para dashboard).
   */
  async getDashboardStats(organizerId: string): Promise<DashboardStats> {
    return this.eventsRepo.getDashboardStats(organizerId);
  }
```

Importe `DashboardStats` do repositório no topo do service:

```typescript
import type {
  EventCreated,
  EventWithDetails,
  EventPublic,
  EventList,
  DashboardStats,   // adicionar
} from './events.repository.js';
```

### O controller

Adicione a rota dentro da classe `EventsController`, após a rota `list`:

```typescript
// apps/event-service/src/modules/events/events.controller.ts
// (adicionar dentro de EventsController, nas rotas de organizer)

  /**
   * GET /events/dashboard/stats
   *
   * Rota dedicada para o dashboard — separada de /events para não poluir
   * o recurso principal com semântica diferente (agregação vs. CRUD).
   * Protegida pelo OrganizerGuard: só organizers autenticados chegam aqui.
   *
   * ATENÇÃO: rota estática deve vir antes de :id para o NestJS não
   * interpretar "dashboard" como um UUID no ParseUUIDPipe de GET :id.
   */
  @Get('dashboard/stats')
  @UseGuards(OrganizerGuard)
  getDashboardStats(
    @CurrentUser() user: AuthenticatedUser,
  ): ReturnType<EventsService['getDashboardStats']> {
    return this.eventsService.getDashboardStats(this.assertOrganizerId(user));
  }
```

> **Por que `/events/dashboard/stats` e não `/dashboard/stats`?**
> O event-service é montado no gateway no prefixo `/events`. Uma rota `/dashboard/stats` exigiria um namespace próprio no gateway — mais configuração sem ganho. Manter sob `/events` respeita a coesão do recurso.

> **Atenção à ordem das rotas no NestJS:** a rota `GET dashboard/stats` (literal) deve ser declarada **antes** de `GET :id` (dinâmico) para o NestJS não interpretar a string `"dashboard"` como um UUID e falhar no `ParseUUIDPipe`. Já é o caso no código acima — basta manter a ordem ao adicionar.

### Ajuste no API Gateway — exclusão de auth não pode ser ampla demais

Há uma armadilha sutil no gateway. No cap-03 a leitura pública de eventos foi liberada com um wildcard amplo:

```typescript
// apps/api-gateway/src/app.module.ts (ANTES — amplo demais)
{ path: 'events/*path', method: RequestMethod.GET },
```

Esse padrão exclui da validação JWT **todo** `GET /events/*` — inclusive a nova rota `GET /events/dashboard/stats`, que é de organizer. Sem passar pelo `JwtAuthMiddleware`, o gateway não injeta o header `x-organizer-id`, e o `OrganizerGuard` do event-service responde **401 "Não autenticado"** — mesmo com um token válido.

A correção é estreitar a exclusão para **apenas** as duas rotas realmente públicas (sem guard):

```typescript
// apps/api-gateway/src/app.module.ts (DEPOIS — só as públicas)
{ path: 'events/:slug/public', method: RequestMethod.GET },
{ path: 'events/:id/public-meta', method: RequestMethod.GET },
```

`events/:slug/public` casa `events/<slug>/public`, mas **não** `events/dashboard/stats` (o último segmento literal `public` não bate com `stats`). Assim `dashboard/stats` volta a exigir auth, enquanto a página pública do evento segue liberada. `GET /events` (lista) nunca foi excluído — sempre exigiu token de organizer.

---

## Passo 13.2 — Dashboard Page (Server Component)

Com o endpoint real existindo, o frontend pode consumi-lo. O `DashboardStatsSchema` é declarado no frontend para manter o arquivo simples — se outros serviços precisarem desse tipo, mova para `@showpass/types`.

#### Auth em Server Components — `apiRequestServer`

O `apiRequest` do cap-10 lê o token do **Zustand**, que vive no `localStorage` do browser. Um **Server Component não tem `localStorage`** — no servidor, `useAuthStore.getState().accessToken` é sempre `null`. Se a página chamasse `apiRequest` direto, o fetch sairia sem `Authorization` e o backend devolveria 401.

A solução: ler o token do **cookie `access_token`** (gravado no login — ver cap-10) via `next/headers`. Criamos um helper server-only:

```typescript
// apps/web/src/lib/api-server.ts
//
// Variante server-only do api-client. Server Components e Route Handlers NÃO
// têm acesso ao Zustand (localStorage do browser) — o token vem do cookie
// `access_token` via next/headers cookies().
//
// `import 'server-only'` quebra o build se um Client Component importar isto.
import 'server-only';

import { cookies } from 'next/headers';
import type { ZodType } from 'zod';
import { apiRequest } from './api-client';

export async function apiRequestServer<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestInit = {},
): Promise<T> {
  const cookieStore = await cookies();
  const token = cookieStore.get('access_token')?.value;

  // new Headers() normaliza HeadersInit sem spread (evita no-misused-spread).
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  // skipAuth evita o lookup do Zustand (null no servidor); o token vai
  // explícito a partir do cookie. Sem refresh server-side — o middleware Edge
  // já barra tokens expirados antes de chegar aqui.
  return apiRequest(path, schema, { ...options, skipAuth: true, headers });
}
```

> Esse mesmo helper serve o Route Handler de export CSV (Passo 13.4) — `cookies()` funciona tanto em Server Components quanto em Route Handlers.

A página do dashboard:

```typescript
// apps/web/src/app/(organizer)/dashboard/page.tsx
//
// Server Component: busca dados pesados no servidor, renderiza HTML completo.
// Client Components apenas para gráficos interativos (Recharts precisa do DOM).

import { Suspense } from 'react';
import { apiRequestServer } from '@/lib/api-server';
import { z } from 'zod';
import { SalesChart } from '@/components/dashboard/sales-chart';
import { MetricCard } from '@/components/dashboard/metric-card';

// Schema Zod espelha exatamente o DashboardStats do event-service.
// Zod 4: z.uuid(), z.number() — não z.string().uuid()
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
    id: z.uuid(),
    title: z.string(),
    sold: z.number(),
    available: z.number(),
    revenue: z.number(),
  })),
});

export default async function DashboardPage() {
  // Server Component async — fetch ocorre no servidor (token via cookie),
  // resultado já no HTML inicial. Sem loading state para as métricas.
  const stats = await apiRequestServer('/events/dashboard/stats', DashboardStatsSchema);

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-8">Dashboard</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
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

      {/* Gráfico de vendas — Client Component */}
      <div className="rounded-3xl border bg-card p-6 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold text-lg">Vendas por Dia</h2>
          <ExportCsvButton />
        </div>
        <Suspense fallback={<div className="h-64 animate-pulse bg-gray-100 rounded" />}>
          <SalesChart data={stats.revenueByDay} />
        </Suspense>
      </div>

      {/* Top Eventos */}
      <div className="rounded-3xl border bg-card p-6 shadow-sm">
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

// Componente separado para clareza — o link de download não precisa de JS
function ExportCsvButton() {
  // Sem .csv no path: segmentos com ponto criam ambiguidade com extensões
  // estáticas no Next.js. Usamos /api/dashboard/export com header
  // Content-Disposition para forçar o download com nome correto.
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
```

O `MetricCard` é um card de KPI sem estado — server-safe, renderiza junto com a
página sem custo de hidratação. O visual segue o estilo **Horizon UI** (card
`rounded-3xl`, ícone Lucide num badge colorido, número grande), com cores via tokens
shadcn para ficar **dark-aware**:

```typescript
// apps/web/src/components/dashboard/metric-card.tsx
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MetricCardProps {
  title: string;
  value: string;
  icon: LucideIcon;            // ícone Lucide (não emoji)
  accentClass?: string;        // cor do badge (bg+text), passada pela página
  trend?: string;
}

export function MetricCard({
  title, value, icon: Icon, accentClass, trend,
}: MetricCardProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 rounded-3xl border bg-card p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className={cn('flex size-12 shrink-0 items-center justify-center rounded-2xl', accentClass)}>
        <Icon className="size-6" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm text-muted-foreground">{title}</p>
        <p className="text-2xl font-bold tracking-tight">{value}</p>
        {trend ? <p className="mt-0.5 truncate text-xs text-muted-foreground/70">{trend}</p> : null}
      </div>
    </div>
  );
}
```

Na página, cada card recebe um ícone Lucide + uma cor de accent (indigo/violet/
emerald/amber), e o gráfico vira uma **área com gradiente** (`AreaChart` do Recharts,
eixos via `var(--muted-foreground)`) em vez do `ComposedChart` com barras:

```typescript
import { DollarSign, Ticket, CalendarCheck2, TrendingUp } from 'lucide-react';

<MetricCard title="Receita Total" value={brl.format(stats.totalRevenue)}
  icon={DollarSign}
  accentClass="bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400" />
// ...Ingressos (violet), Eventos (emerald), Conversão (amber)
```

> A tabela "Top Eventos" ganhou um **empty state** ("Nenhum evento ainda") — sem
> dados, o painel mostra os cards zerados + a mensagem, em vez de uma tabela vazia.

---

## Passo 13.3 — Sales Chart (Recharts)

Instale o Recharts (3.x — compatível com React 19) no app web:

```bash
pnpm --filter @showpass/web add recharts
```

```typescript
// apps/web/src/components/dashboard/sales-chart.tsx
'use client';
//
// Client Component obrigatório: Recharts usa APIs do DOM (ResizeObserver, SVG).
// Server Components não têm acesso ao DOM — importar Recharts num Server
// Component gera erro em runtime.

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

export function SalesChart({ data }: { data: DayData[] }) {
  const formatted = data.map((d) => ({
    ...d,
    // Formatar "YYYY-MM-DD" para "26 set" — mais legível no eixo X
    date: new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' })
      .format(new Date(d.date + 'T00:00:00')),  // forçar hora local, não UTC
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
        <YAxis yAxisId="tickets" orientation="right" tick={{ fontSize: 12 }} />
        <Tooltip
          // Recharts 3: `value` é ValueType|undefined e `name` é o NOME da
          // série (definido em name="Receita"/"Ingressos" abaixo), NÃO a
          // dataKey. Comparar com 'revenue' aqui seria sempre falso.
          formatter={(value, name) => {
            const num = typeof value === 'number' ? value : Number(value ?? 0);
            return [
              name === 'Receita'
                ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(num)
                : num,
              name,
            ];
          }}
        />
        <Legend />
        <Bar yAxisId="revenue" dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Receita" />
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
```

---

## Passo 13.4 — CSV Export (Route Handler)

O Route Handler reutiliza o endpoint `/events/dashboard/stats` já implementado. Não há endpoint separado de exportação — menos superfície de API, mesmos dados.

```typescript
// apps/web/src/app/api/dashboard/export/route.ts
//
// Route Handler Next.js — gera CSV no servidor e retorna como download.
//
// Por que não chamar o event-service diretamente do cliente?
//   1. A API key do gateway ficaria exposta no browser.
//   2. Não há lógica de formatação CSV no servidor → menos JS no bundle cliente.
//   Este handler age como BFF (Backend for Frontend) para operações de export.

import { NextResponse } from 'next/server';
import { apiRequestServer } from '@/lib/api-server';  // lê o cookie (server-side)
import { z } from 'zod';

// Schema idêntico ao do DashboardPage — reutilizar evita drift.
// Alternativa: mover para @showpass/types se outros handlers precisarem.
const TopEventsSchema = z.array(z.object({
  id: z.uuid(),
  title: z.string(),
  sold: z.number(),
  available: z.number(),
  revenue: z.number(),
}));

const DashboardStatsForExportSchema = z.object({
  topEvents: TopEventsSchema,
});

export async function GET(): Promise<NextResponse> {
  // Buscar apenas o que o CSV precisa — topEvents é suficiente
  const { topEvents } = await apiRequestServer(
    '/events/dashboard/stats',
    DashboardStatsForExportSchema,
  );

  // Colunas derivadas de topEvents — sem dados de pagamento (bounded context)
  const header = 'Evento,Vendidos,Disponíveis,Receita (R$)\n';

  const rows = topEvents.map((e) =>
    [
      `"${e.title.replace(/"/g, '""')}"`,  // escapar aspas duplas no CSV (RFC 4180)
      e.sold,
      e.available,
      // pt-BR usa vírgula decimal — que COLIDE com o separador CSV (vírgula).
      // A receita PRECISA ser aspeada, senão "200,00" vira duas colunas
      // (200 e 00) ao abrir no Excel ou em qualquer parser RFC 4180.
      `"${e.revenue.toFixed(2).replace('.', ',')}"`,
    ].join(','),
  );

  const csv = header + rows.join('\n');

  // Nome do arquivo com data: relatorio-YYYY-MM-DD.csv
  const today = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      // filename* (RFC 5987) garante suporte a acentos no nome do arquivo
      'Content-Disposition': `attachment; filename="relatorio-${today}.csv"; filename*=UTF-8''relatorio-${today}.csv`,
    },
  });
}
```

---

## Passo 13.5 — Shell do painel (sidebar shadcn/ui)

Até aqui o dashboard era só a página de conteúdo. O **painel admin** precisa de uma
navegação própria — uma sidebar. Usamos os componentes `sidebar`/`sheet` do
shadcn/ui (ver [cap-10 → shadcn/ui](cap-10-frontend-foundation.md)). O grupo de rotas
`(organizer)` ganha um `layout.tsx` que envolve as páginas no shell.

```typescript
// apps/web/src/app/(organizer)/layout.tsx
import {
  SidebarInset, SidebarProvider, SidebarTrigger,
} from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/dashboard/app-sidebar';

export default function OrganizerLayout({
  children,
}: { children: React.ReactNode }): React.JSX.Element {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <span className="text-sm font-medium">Painel do Organizador</span>
          {/* Ações do topbar: alternar tema + logout */}
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <LogoutButton />
          </div>
        </header>
        <div className="p-4 sm:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
```

A `AppSidebar` ([components/dashboard/app-sidebar.tsx](apps/web/src/components/dashboard/app-sidebar.tsx))
lista os itens de navegação com ícones Lucide. Note o `render={<Link/>}` (padrão Base
UI — equivalente ao `asChild` do Radix) e o `isActive` por `usePathname`:

```typescript
<SidebarMenuButton
  isActive={pathname === item.url}
  tooltip={item.title}
  render={<Link href={item.url} />}
>
  <item.icon />
  <span>{item.title}</span>
</SidebarMenuButton>
```

> O `Header` global (cap-10) **some** nas rotas do organizer (`/dashboard`,
> `/events/create`, `/events/edit`) — lá a sidebar é a navegação. Ele faz isso com
> `usePathname()` retornando `null` nesses prefixos.

A sidebar tem um **footer com o usuário** (avatar com a inicial + e-mail + botão
"Sair"), no padrão `NavUser` do template [next-shadcn-admin-dashboard](https://github.com/arhamkhnz/next-shadcn-admin-dashboard)
(MIT). Como o e-mail vem do `useAuthStore` (só hidrata no cliente), há o gate
`mounted` — o SSR mostra "Organizador" e o cliente troca pelo e-mail real.

### Estética Horizon UI

As cores do painel seguem a paleta do **Horizon UI** (free), remapeada nos tokens
semânticos do shadcn em `globals.css` — então sidebar, cards e tudo herdam de uma vez:
fundo `#F4F7FE` / navy `#0b1437` (dark), marca `#422AFB`/`#7551FF`, texto secundário
`#707EAE`, fonte **DM Sans**, e a sombra suave `shadow-card`. O dashboard ganhou um
**banner com gradiente de marca** (elemento-assinatura do Horizon) no topo.

## Passo 13.6 — Data-table de eventos (TanStack)

A tabela "Top Eventos" usa um **data-table** com [@tanstack/react-table](https://tanstack.com/table)
(headless) + os componentes `Table` do shadcn — mesmo padrão do template
next-shadcn-admin-dashboard. Ordenação por coluna, alinhamento numérico à direita e
empty state. É um Client Component (TanStack usa hooks), recebendo `stats.topEvents`
(já buscado no servidor) como prop:

```typescript
// apps/web/src/components/dashboard/events-table.tsx — 'use client'
const table = useReactTable({
  data,
  columns,                       // ColumnDef<EventRow>[] (header clicável → toggleSorting)
  state: { sorting },
  onSortingChange: setSorting,
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),  // ordenação client-side
});
// render: <Table> + flexRender(header/cell) + empty state quando rows.length === 0
```

E na página, a tabela crua vira uma linha só:

```typescript
import { EventsTable } from '@/components/dashboard/events-table';
// ...
<EventsTable data={stats.topEvents} />
```

> **Por que TanStack + shadcn Table** (e não um `<table>` cru): a ordenação/paginação/
> filtro vêm prontos e desacoplados da renderização (headless), e a aparência usa os
> mesmos componentes shadcn do resto do app. O `Table` do shadcn é Base UI; o TanStack
> não traz UI, então não há conflito de stack.

---

## Testando na prática

> **Guia completo:** ver [docs/guia-de-testes.md — Fluxo 3](guia-de-testes.md#6-fluxo-3--painel-do-organizador-dashboard).
> Inclui passo a passo com comandos curl para criar evento, lotes e publicar.

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
- Cards com métricas: total de ingressos vendidos, receita total (estimativa bruta), eventos ativos
- Gráfico de barras/linhas com distribuição por dia de criação dos eventos
- Tabela de top 10 eventos por ingressos vendidos

**3. Verificar o endpoint diretamente**

No terminal, confirme que o event-service responde corretamente:

```bash
# Substitua <TOKEN> pelo JWT do organizer logado
curl -s \
  -H "Authorization: Bearer <TOKEN>" \
  -H "x-organizer-id: <ORGANIZER_UUID>" \
  http://localhost:3000/events/dashboard/stats | jq .
```

Resposta esperada:

```json
{
  "totalRevenue": 15000,
  "totalTicketsSold": 300,
  "activeEvents": 2,
  "conversionRate": 0,
  "revenueByDay": [
    { "date": "2025-09-26", "revenue": 7500, "tickets": 150 }
  ],
  "topEvents": [
    {
      "id": "uuid-aqui",
      "title": "Rock in Rio 2025",
      "sold": 150,
      "available": 350,
      "revenue": 7500
    }
  ]
}
```

**4. Verificar que métricas chegam no HTML (Server Component)**

No DevTools → Network, recarregue a página. A request inicial ao `/dashboard` deve retornar o HTML já com os dados das métricas — não há loading states para as métricas principais. Isso é o PPR (Partial Prerendering) em ação.

**5. Exportar CSV de relatório**

Clique no botão "Exportar CSV". O browser deve baixar um arquivo `relatorio-YYYY-MM-DD.csv` (ex.: `relatorio-2025-09-26.csv`) com as colunas:

```
Evento,Vendidos,Disponíveis,Receita (R$)
"Rock in Rio 2025",150,350,"7500,00"
```

**6. Verificar formatação em pt-BR**

Os valores monetários devem exibir `R$ 1.500,00` (ponto como separador de milhares, vírgula como decimal) — `Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })`.

As datas no gráfico devem exibir no formato `26 set` — `Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' })`.

**7. Testar isolamento multi-tenant**

Faça login com `outro@teste.com` e acesse o dashboard. Você **não** deve ver os eventos nem as métricas do `admin@rockshows.com.br`. O `organizerId` vem do header `x-organizer-id` injetado pelo gateway após validar o JWT — a query Prisma filtra por ele, então `outro@teste.com` verá `activeEvents: 0` e arrays vazios.

Confirme via curl também:

```bash
curl -s \
  -H "Authorization: Bearer <TOKEN_OUTRO_ORGANIZER>" \
  -H "x-organizer-id: <UUID_OUTRO_ORGANIZER>" \
  http://localhost:3000/events/dashboard/stats | jq .activeEvents
# Saída esperada: 0
```

**8. Verificar responsividade**

Redimensione o browser para largura de 375px (iPhone). O gráfico Recharts deve se adaptar via `ResponsiveContainer width="100%"` e as métricas empilharem verticalmente (grid `grid-cols-2 lg:grid-cols-4`).

---

## Recapitulando

1. **Bounded contexts isolados** — o endpoint `/events/dashboard/stats` agrega dados lendo **apenas** o banco do event-service (`events` + `ticket_batches`). Sem chamadas cross-service em runtime
2. **Tenant isolation** — toda query Prisma filtra por `organizerId` extraído do header `x-organizer-id` (injetado pelo gateway); o `OrganizerGuard` garante que chegue sempre presente
3. **Trade-offs documentados** — `totalRevenue` é estimativa bruta (reconciliação real no cap-18); `revenueByDay` usa data de criação como aproximação; `conversionRate` aguarda tracking de views (cap-17)
4. **Server Component** para métricas pesadas — dados chegam no HTML, zero loading state para o conteúdo principal
5. **Recharts `ComposedChart`** — barra (receita) + linha (ingressos) no mesmo gráfico com dois eixos Y
6. **CSV via Route Handler** — reutiliza `/events/dashboard/stats`, gerado no servidor, sem expor a API key no cliente; colunas consistentes com a tabela do dashboard

---

## Próximo capítulo

[Capítulo 14 → Testes](cap-14-testes.md)
