// apps/auth-service/src/prisma/prisma.service.ts
//
// Wrapper do Prisma Client como serviço NestJS.
// Herda de PrismaClient para expor os métodos de acesso ao banco diretamente.
//
// Prisma 7 "client" engine type exige driver adapter — não aceita conexão direta
// sem adapter (breaking change do Prisma 7).
// @prisma/adapter-pg usa pg.Pool internamente (pool de conexões nativo Node.js).

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/index.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // DATABASE_URL já foi carregado pelo dotenv no main.ts
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    const adapter = new PrismaPg(pool);
    //super({ adapter });
    
    super({ 
      adapter,
      log: process.env['NODE_ENV'] === 'development'         
        ? [
            { emit: 'event', level: 'query' as const },
            { emit: 'stdout', level: 'error' as const },
            { emit: 'stdout', level: 'warn' as const },
          ] 
        : ['error']
    });
  }

  async onModuleInit(): Promise<void> {
    if (process.env['NODE_ENV'] === 'development') {
      // Log de queries em dev. O log level 'query' como 'event' já é
      // configurado no constructor; o $on do Prisma 7 não infere o shape
      // do evento, então tipamos explicitamente (sem @ts-ignore/any).
      const onQuery = this.$on.bind(this) as unknown as (
        event: 'query',
        cb: (e: { query: string; params: string; duration: number }) => void,
      ) => void;
      onQuery('query', (e) => {
        console.log('\n--- Prisma Query ---');
        console.log(`Query: ${e.query}`);
        console.log(`Params: ${e.params}`);
        console.log(`Duration: ${String(e.duration)}ms`);
        console.log('--------------------\n');
      });
    }

    // Conectar explicitamente na inicialização para detectar problemas cedo
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    // Fechar conexões ao encerrar — evitar connection leaks em testes
    await this.$disconnect();
  }
}
