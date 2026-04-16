// apps/event-service/prisma.config.ts
//
// Prisma 7: a URL do banco vem de prisma.config.ts, não do schema.prisma.
// Campo correto: datasource.url (NÃO datasourceUrl — esse campo não existe em Prisma 7).
// import 'dotenv/config' carrega o .env antes de process.env ser lido pelo Prisma CLI.

import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
