// apps/worker-service/src/modules/dlq/dlq-audit.consumer.ts
//
// Escuta o tópico .dlt e gera alerta (Slack/PagerDuty no cap-17). Isolado
// em consumer próprio (o DLT pode ter regras diferentes: group separado,
// low-throughput).

import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KAFKA_TOPICS } from '@showpass/types';

@Controller()
export class DlqAuditConsumer {
  private readonly logger = new Logger(DlqAuditConsumer.name);

  @EventPattern(`${KAFKA_TOPICS.PAYMENT_CONFIRMED}.dlt`)
  onDlt(@Payload() payload: unknown): void {
    this.logger.error('DLT: payments.payment-confirmed.dlt', { payload });
    // cap-17: integração com Slack/PagerDuty
    // await this.alerting.send({ severity: 'high', payload, ... });
  }
}
