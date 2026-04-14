// apps/event-service/prisma/seed.ts
//
// Popula o banco com dados iniciais para desenvolvimento.
// Plans SaaS, Categories, e Organizer de exemplo.
//
// Usar upsert em vez de create: idempotente — pode rodar múltiplas vezes.

import { PrismaClient } from '../src/prisma/generated/index.js';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // ─── Plans (tiers SaaS) ────────────────────────────────────────────────────

  await prisma.plan.upsert({
    where: { slug: 'free' },
    create: {
      name: 'Free',
      slug: 'free',
      maxActiveEvents: 2,
      maxVenues: 1,
      serviceFeePercent: 10.0,
      hasAnalytics: false,
      hasApiAccess: false,
      hasWhiteLabel: false,
      priceMonthly: 0,
    },
    update: {},
  });

  await prisma.plan.upsert({
    where: { slug: 'pro' },
    create: {
      name: 'Pro',
      slug: 'pro',
      maxActiveEvents: 20,
      maxVenues: 5,
      serviceFeePercent: 7.0,
      hasAnalytics: true,
      hasApiAccess: false,
      hasWhiteLabel: false,
      priceMonthly: 99.90,
    },
    update: {},
  });

  await prisma.plan.upsert({
    where: { slug: 'enterprise' },
    create: {
      name: 'Enterprise',
      slug: 'enterprise',
      maxActiveEvents: 999,
      maxVenues: 999,
      serviceFeePercent: 4.0,
      hasAnalytics: true,
      hasApiAccess: true,
      hasWhiteLabel: true,
      priceMonthly: 499.90,
    },
    update: {},
  });

  // ─── Categories ────────────────────────────────────────────────────────────

  const categories = [
    { name: 'Shows e Música',  slug: 'shows-musica',  icon: 'music' },
    { name: 'Teatro e Dança',  slug: 'teatro-danca',  icon: 'theater' },
    { name: 'Esportes',        slug: 'esportes',       icon: 'sports' },
    { name: 'Conferências',    slug: 'conferencias',   icon: 'conference' },
    { name: 'Festivais',       slug: 'festivais',      icon: 'festival' },
    { name: 'Stand-up',        slug: 'stand-up',       icon: 'comedy' },
  ];

  for (const cat of categories) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      create: cat,
      update: {},
    });
  }

  console.log('Seed concluido: plans e categories criados');
}

main()
  .catch(console.error)
  .finally(() => {
    void prisma.$disconnect();
  });
