// apps/web/src/app/(public)/events/[slug]/page.tsx
//
// Server Component — renderizado no servidor com dados frescos.
// O HTML final já contém título, descrição, OG tags e Schema.org Event.
// Google indexa o evento completo sem precisar de JavaScript.
//
// Next.js 16: `params` é uma Promise — obrigatório `await params` antes
// de acessar qualquer campo. Omitir o await causa TypeError silencioso
// em produção (os campos aparecem como undefined).

import type React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getEventBySlug } from '@/lib/api/events';
import { EventPageClient } from './event-page.client';
import { SeatMapSkeleton } from '@/components/events/seat-map-skeleton';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  try {
    const event = await getEventBySlug(slug);

    return {
      title: event.title,
      description: `${event.title} — ${event.venue.name}, ${event.venueCity}/${event.venueState}. Compre seus ingressos no ShowPass.`,
      openGraph: {
        title: event.title,
        description: `${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full' }).format(new Date(event.startAt))} • ${event.venue.name}`,
        images: event.thumbnailUrl
          ? [{ url: event.thumbnailUrl, width: 1200, height: 630 }]
          : [],
        type: 'website',
      },
      twitter: {
        card: 'summary_large_image',
        title: event.title,
        images: event.thumbnailUrl ? [event.thumbnailUrl] : [],
      },
    };
  } catch {
    return { title: 'Evento não encontrado' };
  }
}

export default async function EventPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;

  const event = await getEventBySlug(slug).catch(() => null);

  if (!event) {
    notFound();
  }

  const eventDate = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(event.startAt));

  // Schema.org minPrice: menor preço entre lotes visíveis com estoque
  const minPrice = event.ticketBatches
    .filter((b) => b.isVisible && b.soldCount < b.totalQuantity)
    .reduce<number | null>(
      (min, b) => (min === null || b.price < min ? b.price : min),
      null,
    );

  const hasAvailableTickets = minPrice !== null;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Event',
            name: event.title,
            startDate: event.startAt,
            endDate: event.endAt,
            location: {
              '@type': 'Place',
              name: event.venue.name,
              address: {
                '@type': 'PostalAddress',
                streetAddress: event.venue.address,
                addressLocality: event.venueCity,
                addressRegion: event.venueState,
                addressCountry: 'BR',
              },
            },
            offers:
              minPrice !== null
                ? {
                    '@type': 'Offer',
                    availability: hasAvailableTickets
                      ? 'https://schema.org/InStock'
                      : 'https://schema.org/SoldOut',
                    price: minPrice,
                    priceCurrency: 'BRL',
                    url: `https://showpass.com.br/events/${slug}`,
                  }
                : undefined,
            image: event.thumbnailUrl,
            organizer: {
              '@type': 'Organization',
              name: event.organizer.name,
            },
          }),
        }}
      />

      <main className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            {event.thumbnailUrl && (
              <div className="relative w-full aspect-video rounded-2xl overflow-hidden mb-6">
                {/* <img> raw em vez de next/image: imagens vêm de hosts
                    declarados em next.config.ts (remotePatterns). Trocar
                    por <Image /> fica para um capítulo de otimização. */}
                <img
                  src={event.thumbnailUrl}
                  alt={event.title}
                  className="object-cover w-full h-full"
                />
              </div>
            )}

            <h1 className="text-3xl font-bold mb-2">{event.title}</h1>
            <p className="text-gray-600 mb-1 capitalize">{eventDate}</p>
            <p className="text-gray-600 mb-6">
              {event.venue.name} • {event.venueCity}/{event.venueState}
            </p>

            <div className="prose max-w-none">
              <p>{event.description}</p>
            </div>
          </div>

          <div className="lg:col-span-1">
            <Suspense fallback={<SeatMapSkeleton />}>
              <EventPageClient event={event} />
            </Suspense>
          </div>
        </div>
      </main>
    </>
  );
}
