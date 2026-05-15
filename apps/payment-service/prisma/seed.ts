// apps/payment-service/prisma/seed.ts
//
// Popula showpass_payment com os planos SaaS. Slugs idênticos aos de
// auth-service/event-service (o OrganizersConsumer faz findUnique por slug).
//
// import 'dotenv/config' deve ser a PRIMEIRA linha — carrega DATABASE_URL
// antes que o Pool tente conectar.

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/generated/index.js';

// Prisma 7: "client" engine exige driver adapter (não usa binary engine).
const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  // upsert é idempotente — o script pode rodar várias vezes
  const plans = [
    { slug: 'free',       name: 'Free',       serviceFeePercent: 10.0 },
    { slug: 'pro',        name: 'Pro',        serviceFeePercent:  7.0 },
    { slug: 'enterprise', name: 'Enterprise', serviceFeePercent:  4.0 },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where:  { slug: plan.slug },
      create: plan,
      update: { name: plan.name, serviceFeePercent: plan.serviceFeePercent },
    });
  }

  console.log('Seed payment-service concluído: 3 planos (free/pro/enterprise)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
