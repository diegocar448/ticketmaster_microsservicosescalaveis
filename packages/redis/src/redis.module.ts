import { DynamicModule, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

export interface RedisModuleOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS: módulos com forRoot() são classes estáticas por design
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    const redisProvider = {
      provide: REDIS_CLIENT,
      useFactory: (): Redis => {
        const client = new Redis({
          host: options.host,
          port: options.port,
          password: options.password,
          db: options.db ?? 0,
          // Reconectar automaticamente com backoff exponencial
          retryStrategy: (times: number): number => Math.min(times * 50, 2000),
          // Timeout de conexão: 5s
          connectTimeout: 5000,
          // Manter conexão viva com PING periódico
          keepAlive: 10000,
          // Desabilitar modo legado (usar Promises nativas)
          lazyConnect: false,
        });

        client.on('error', (err) => {
          console.error('[Redis] Erro de conexão:', err);
        });

        return client;
      },
    };

    return {
      module: RedisModule,
      providers: [redisProvider, RedisService],
      exports: [REDIS_CLIENT, RedisService],
      global: true,  // disponível em todos os módulos sem reimportar
    };
  }
}