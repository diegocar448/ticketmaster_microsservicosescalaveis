// apps/auth-service/prisma/seed.ts
//
// Popula showpass_auth com os planos SaaS iniciais.
//
// Usar upsert: idempotente — pode rodar múltiplas vezes sem duplicar.
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
  // ─── Plans (tiers SaaS) ────────────────────────────────────────────────────
  // auth-service só precisa do slug para associar organizer ao plano.
  // Detalhes de limites ficam no event-service (responsabilidade separada).

  const plans = [
    { slug: 'free',       name: 'Free'       },
    { slug: 'pro',        name: 'Pro'        },
    { slug: 'enterprise', name: 'Enterprise' },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where:  { slug: plan.slug },
      create: plan,
      update: {},
    });
  }

  console.log('Seed auth-service concluído: 3 planos criados (free, pro, enterprise)');
}

main()
  .catch(console.error)
  .finally(() => {
    void prisma.$disconnect();
    void pool.end();
  });
