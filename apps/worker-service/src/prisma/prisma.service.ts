// apps/worker-service/src/prisma/prisma.service.ts
//
// Wrapper do PrismaClient para injeção de dependência no NestJS.
// Prisma 7 "client" engine type exige driver adapter (@prisma/adapter-pg);
// o pg.Pool reaproveita conexões entre queries.

import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/index.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // DATABASE_URL já foi carregado pelo dotenv no main.ts
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    const adapter = new PrismaPg(pool);
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma conectado — worker database');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
