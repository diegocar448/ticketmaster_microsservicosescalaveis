import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import type { KafkaTopic } from '@showpass/types';

@Injectable()
export class KafkaProducerService implements OnModuleInit {
  private readonly logger = new Logger(KafkaProducerService.name);

  constructor(
    @Inject('KAFKA_CLIENT')
    private readonly client: ClientKafka,
  ) {}

  async onModuleInit(): Promise<void> {
    // Conectar ao broker na inicialização do módulo
    await this.client.connect();
    this.logger.log('Kafka producer conectado');
  }

  /**
   * Emite um evento no tópico especificado.
   *
   * @param topic - tópico tipado do KAFKA_TOPICS
   * @param payload - payload validado pelo Zod schema do tópico
   * @param key - chave de particionamento (geralmente o ID do agregado)
   *              Garante que eventos do mesmo agregado vão para a mesma partição
   *              e são processados em ordem
   */
  async emit<T>(topic: KafkaTopic, payload: T, key?: string): Promise<void> {
    const message = {
      key: key ?? null,
      value: JSON.stringify({
        ...payload,
        _meta: {
          topic,
          emittedAt: new Date().toISOString(),
        },
      }),
    };

    await this.client.emit(topic, message).toPromise();

    this.logger.debug(`Evento emitido: ${topic}`, { key });
  }
}