// Token de injeção do cliente Redis.
// Extraído do redis.module.ts para quebrar a dependência circular:
//   redis.module.ts → redis.service.ts → redis.module.ts (CIRCULAR)
// Com este arquivo, ambos importam de uma fonte sem dependências.
export const REDIS_CLIENT = 'REDIS_CLIENT';
