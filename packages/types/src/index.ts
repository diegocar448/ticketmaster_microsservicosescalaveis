// packages/types/src/index.ts
// Fonte única de verdade para tipos compartilhados entre frontend e backend.
// Cada schema Zod gera tanto o tipo TypeScript estático quanto a validação em runtime.

export * from './auth.js';
export * from './events.js';
export * from './bookings.js';
export * from './payments.js';
export * from './kafka-topics.js';
