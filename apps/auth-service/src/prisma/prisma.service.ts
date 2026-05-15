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
      // @ts-ignore - Prisma 7 event typing
      this.$on('query', (e: any) => {
        console.log('\n--- Prisma Query ---');
        console.log(`Query: ${e.query}`);
        console.log(`Params: ${e.params}`);
        console.log(`Duration: ${e.duration}ms`);
        console.log('--------------------\n');
      });

      // No Prisma 7, extensões retornam uma nova instância.
      // Usamos Object.assign para que a instância injetada pelo NestJS receba os comportamentos da extensão.
      const extendedClient = this.$extends({
        query: {
          async $allOperations({ operation, model, args, query }) {
            const result = await query(args);
            if (process.env['NODE_ENV'] === 'development') {
              console.log(`\n[Prisma Result] ${model}.${operation} return:`, 
                JSON.stringify(result, null, 2), '\n');
            }
            return result;
          },
        },
      });
      
      Object.assign(this, extendedClient);
    }

    // Conectar explicitamente na inicialização para detectar problemas cedo
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    // Fechar conexões ao encerrar — evitar connection leaks em testes
    await this.$disconnect();
  }
}
