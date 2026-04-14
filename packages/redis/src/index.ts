// packages/redis/src/index.ts
// Ponto de entrada do pacote @showpass/redis.
// ATENÇÃO: os Lua scripts em redis.service.ts são CRÍTICOS para o anti-double-booking.
// Ver packages/redis/CLAUDE.md antes de qualquer alteração.
export { RedisModule, REDIS_CLIENT } from './redis.module.js';
export type { RedisModuleOptions } from './redis.module.js';
export { RedisService } from './redis.service.js';
