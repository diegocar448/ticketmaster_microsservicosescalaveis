// NestJS module que encapsula o cliente Kafka.
// Cada serviço importa este módulo e usa KafkaProducerService ou
// @EventPattern nos controllers.

import { DynamicModule, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { KafkaProducerService } from './kafka-producer.service';

export interface KafkaModuleOptions {
  clientId: string;
  brokers: string[];
  groupId: string;
}

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS: módulos com forRoot() são classes estáticas por design
export class KafkaModule {
  static forRoot(options: KafkaModuleOptions): DynamicModule {
    return {
      module: KafkaModule,
      imports: [
        ClientsModule.register([
          {
            name: 'KAFKA_CLIENT',
            transport: Transport.KAFKA,
            options: {
              client: {
                clientId: options.clientId,
                brokers: options.brokers,
              },
              consumer: {
                groupId: options.groupId,
                // Não reprocessar mensagens já consumidas ao reiniciar
                allowAutoTopicCreation: false,
              },
              producer: {
                // Garantia de entrega: espera confirmação de todos os replicas
                acks: -1,
                // Retry com backoff exponencial
                retry: { retries: 5 },
              },
            },
          },
        ]),
      ],
      providers: [KafkaProducerService],
      exports: [KafkaProducerService, ClientsModule],
    };
  }
}