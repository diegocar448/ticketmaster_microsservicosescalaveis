// apps/auth-service/prisma.config.ts
// Configuração do Prisma 7 — URL do banco via variável de ambiente.
// Prisma 7 separou a config do schema para suportar múltiplos adapters.

import { defineConfig } from 'prisma/config';

export default defineConfig({
  datasourceUrl: process.env['DATABASE_URL'],
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
});
