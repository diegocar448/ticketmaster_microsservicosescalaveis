// apps/api-gateway/src/modules/proxy/proxy.module.ts
// Módulo de proxy reverso — roteia requests para os microserviços internos.

import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller.js';

@Module({
  controllers: [ProxyController],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS: módulo sem providers próprios
export class ProxyModule {}
