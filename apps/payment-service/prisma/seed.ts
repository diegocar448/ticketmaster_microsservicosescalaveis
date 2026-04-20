// apps/payment-service/prisma/seed.ts
//
// Popula a tabela `plans` (réplica local) com os mesmos slugs seedados em
// auth-service e event-service. Os slugs são a chave de correlação — UUIDs
// diferem entre bancos mas free/pro/enterprise são estáveis.
//
// Sem esses plans, o OrganizersConsumer aborta o upsert (plan.id não resolve),
// e o checkout vira um 500 porque o Organizer local fica sem planId válido.

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/generated/index.js';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  // Mesmos serviceFeePercent do event-service (fonte da verdade do SaaS tier).
  await prisma.plan.upsert({
    where: { slug: 'free' },
    create: { slug: 'free', name: 'Free', serviceFeePercent: 10.0 },
    update: {},
  });

  await prisma.plan.upsert({
    where: { slug: 'pro' },
    create: { slug: 'pro', name: 'Pro', serviceFeePercent: 7.0 },
    update: {},
  });

  await prisma.plan.upsert({
    where: { slug: 'enterprise' },
    create: { slug: 'enterprise', name: 'Enterprise', serviceFeePercent: 4.0 },
    update: {},
  });

  // eslint-disable-next-line no-console -- feedback visível no stdout do seed
  console.log('✔ payment-service: plans seedados (free/pro/enterprise)');
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console -- feedback visível em caso de falha
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
    void pool.end();
  });
