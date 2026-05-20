// packages/types/src/index.ts
// Entry PURO (Zod + tipos) — seguro para frontend e backend.
// Cada schema Zod gera tanto o tipo TypeScript estático quanto a validação em runtime.
//
// O decorator NestJS `CurrentUser` NÃO vive aqui: importar @nestjs/common
// arrastaria class-transformer/class-validator para o bundle do frontend
// (que não tem NestJS). Ele é exposto no subpath `@showpass/types/nest`.

export * from './auth.js';
export * from './events.js';
export * from './bookings.js';
export * from './payments.js';
export * from './kafka-topics.js';
