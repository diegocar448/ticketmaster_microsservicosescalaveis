// packages/kafka/src/index.ts
// Ponto de entrada do pacote @showpass/kafka.
// Exporta o módulo NestJS e o serviço de produção de eventos.
export { KafkaModule } from './kafka.module.js';
export type { KafkaModuleOptions } from './kafka.module.js';
export { KafkaProducerService } from './kafka-producer.service.js';
