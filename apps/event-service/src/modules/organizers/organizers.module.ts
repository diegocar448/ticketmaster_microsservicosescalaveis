// apps/event-service/src/modules/organizers/organizers.module.ts
//
// Módulo só-consumer: não expõe HTTP. A FK `organizerId` em Event/Venue é
// quem consome esses dados via queries Prisma diretas.

import { Module } from '@nestjs/common';
import { OrganizersConsumer } from './organizers.consumer.js';

@Module({
  // Consumer é registrado como controller — NestJS + microservices roteia
  // @EventPattern a partir de controllers.
  controllers: [OrganizersConsumer],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class OrganizersModule {}
