// apps/search-service/src/app.module.ts
//
// Raiz do search-service. ElasticsearchModule global (search + indexer
// injetam ElasticsearchService) + KafkaModule (consumer dos events.event-*).

import { Module } from '@nestjs/common';
import { ElasticsearchModule } from '@nestjs/elasticsearch';
import { KafkaModule } from '@showpass/kafka';

import { HealthModule } from './modules/health/health.module.js';
import { SearchController } from './modules/search/search.controller.js';
import { SearchService } from './modules/search/search.service.js';
import { IndexBootstrapService } from './modules/search/index-bootstrap.service.js';
import { EventIndexerController } from './modules/indexer/event-indexer.controller.js';

@Module({
  imports: [
    ElasticsearchModule.register({
      node: process.env['ELASTICSEARCH_NODE'] ?? 'http://localhost:9200',
      // Em prod: TLS + auth básica via env (ELASTICSEARCH_USERNAME/PASSWORD)
    }),
    KafkaModule.forRoot({
      clientId: process.env['KAFKA_CLIENT_ID'] ?? 'search-service',
      brokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
      groupId: process.env['KAFKA_GROUP_ID'] ?? 'search-service-group',
    }),
    HealthModule,
  ],
  controllers: [SearchController, EventIndexerController],
  providers: [SearchService, IndexBootstrapService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
