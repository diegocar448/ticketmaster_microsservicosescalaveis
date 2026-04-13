// packages/redis/src/index.ts
// Módulo Redis reutilizável — exportado para todos os serviços NestJS.
// Implementação completa no Capítulo 2 (RedisModule, RedisService, Lua scripts).
// ATENÇÃO: os Lua scripts em redis.service.ts são CRÍTICOS para o anti-double-booking.
// Ver packages/redis/CLAUDE.md antes de qualquer alteração.

export * from './redis.module.js';
export * from './redis.service.js';
