// apps/event-service/prisma.config.ts
//
// Prisma 7 exige configuração explícita via defineConfig.
// A url do datasource não é mais aceita no schema.prisma —
// isso separa infraestrutura (URL de banco) de definição de schema.

import { defineConfig } from 'prisma/config';

export default defineConfig({
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
  datasourceUrl: process.env['DATABASE_URL'],
});
