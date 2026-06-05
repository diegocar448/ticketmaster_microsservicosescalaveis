// apps/web/src/app/(public)/events/page.tsx
//
// Listagem pública de eventos on_sale. Server Component: fetch no servidor
// com revalidate de 60s (eventos não mudam a cada segundo).
// Sem autenticação — GET /events/browse é rota pública.

import type React from 'react';
import Link from 'next/link';
import { Calendar, MapPin, Ticket } from 'lucide-react';

interface EventItem {
  id: string;
  slug: string;
  title: string;
  startAt: string;
  venue: { name: string; city: string };
  _count: { ticketBatches: number };
}

interface EventList {
  items: EventItem[];
  total: number;
  page: number;
  limit: number;
}

async function fetchPublicEvents(): Promise<EventList> {
  const res = await fetch(
    `${process.env['NEXT_PUBLIC_API_URL']}/events/browse?page=1&limit=12`,
    { next: { revalidate: 60 } },
  );

  if (!res.ok) return { items: [], total: 0, page: 1, limit: 12 };
  return res.json() as Promise<EventList>;
}

export default async function EventsPage(): Promise<React.JSX.Element> {
  const { items, total } = await fetchPublicEvents();

  return (
    <main className="min-h-screen bg-[#0a0a0f] px-6 py-16">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-10 text-center">
          <h1 className="bg-linear-to-br from-white via-blue-200 to-violet-300 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
            Eventos
          </h1>
          <p className="mt-3 text-slate-400">
            {total > 0
              ? `${String(total)} evento${total !== 1 ? 's' : ''} disponível${total !== 1 ? 'is' : ''}`
              : 'Nenhum evento disponível no momento'}
          </p>
        </div>

        {/* Grade de eventos */}
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-24 text-slate-500">
            <Ticket className="size-12 opacity-30" />
            <p className="text-lg">Nenhum evento à venda no momento.</p>
            <p className="text-sm">Volte em breve para novidades!</p>
          </div>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((event) => (
              <li key={event.id}>
                <Link
                  href={`/events/${event.slug}`}
                  className="group flex h-full flex-col rounded-2xl border border-blue-500/15 bg-slate-900/60 p-6 backdrop-blur-sm transition hover:border-blue-500/40 hover:bg-slate-800/60"
                >
                  {/* Badge lote */}
                  <span className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-400">
                    <Ticket className="size-3" />
                    {event._count.ticketBatches} {event._count.ticketBatches === 1 ? 'lote' : 'lotes'}
                  </span>

                  <h2 className="flex-1 text-lg font-semibold leading-snug text-slate-50 group-hover:text-blue-300 transition-colors">
                    {event.title}
                  </h2>

                  <div className="mt-4 space-y-2 text-sm text-slate-400">
                    <div className="flex items-center gap-2">
                      <Calendar className="size-4 shrink-0 text-blue-500/60" />
                      <span>
                        {new Date(event.startAt).toLocaleDateString('pt-BR', {
                          day: '2-digit',
                          month: 'long',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <MapPin className="size-4 shrink-0 text-blue-500/60" />
                      <span>{event.venue.name} — {event.venue.city}</span>
                    </div>
                  </div>

                  <div className="mt-5 flex items-center justify-end">
                    <span className="rounded-full bg-blue-500/15 px-4 py-1.5 text-xs font-semibold text-blue-300 transition group-hover:bg-blue-500/25">
                      Ver ingressos →
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
