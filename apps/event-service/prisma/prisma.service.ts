// Prisma 7 + @prisma/extension-read-replicas
// O Prisma roteia automaticamente:
//   - prisma.$transaction() → Primary (escrita)
//   - prisma.event.findMany() → Read-Replica (leitura)
//   - prisma.event.create()  → Primary (escrita)

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient, Prisma } from './generated';
import { readReplicas } from '@prisma/extension-read-replicas';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  // Cliente com suporte a read-replica
  // Queries de leitura vão para DATABASE_REPLICA_URL automaticamente
  // Queries de escrita (create, update, delete, $transaction) vão para DATABASE_URL
  readonly db: ReturnType<typeof this._buildExtendedClient>;

  constructor() {
    super({
      log: process.env.NODE_ENV === 'development'
        ? [{ emit: 'event', level: 'query' }, { emit: 'stdout', level: 'warn' }]
        : [{ emit: 'stdout', level: 'error' }],
    });

    // Ativar extension de read-replica apenas se DATABASE_REPLICA_URL estiver configurado
    // Em desenvolvimento (sem replica), usa o primary para tudo
    this.db = this._buildExtendedClient();
  }

  private _buildExtendedClient() {
    const replicaUrl = process.env.DATABASE_REPLICA_URL;

    if (replicaUrl) {
      return (this as PrismaClient).$extends(
        readReplicas({ url: replicaUrl }),
      );
    }

    // Sem replica configurada → usar primary para tudo (dev/staging)
    return this as PrismaClient;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      process.env.DATABASE_REPLICA_URL
        ? 'Prisma conectado — Primary + Read-Replica ativos'
        : 'Prisma conectado — Primary only (sem read-replica)',
    );

    if (process.env.NODE_ENV === 'development') {
      this.$on('query', (e: Prisma.QueryEvent) => {
        if (e.duration > 100) {
          this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
        }
      });
    }
  }
}