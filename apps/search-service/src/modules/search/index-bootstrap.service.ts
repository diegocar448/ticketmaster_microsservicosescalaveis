// apps/search-service/src/modules/search/index-bootstrap.service.ts
//
// Cria o índice "events" no boot, se não existir. Idempotente: múltiplos pods
// sobem em paralelo e só um cria de fato (o segundo pega o índice já criado).

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import type { estypes } from '@elastic/elasticsearch';
import { EVENT_INDEX, EVENT_INDEX_MAPPING } from './event-index.js';

@Injectable()
export class IndexBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IndexBootstrapService.name);

  constructor(private readonly es: ElasticsearchService) {}

  async onApplicationBootstrap(): Promise<void> {
    const exists = await this.es.indices.exists({ index: EVENT_INDEX });
    if (exists) {
      this.logger.log(`Índice "${EVENT_INDEX}" já existe`);
      return;
    }

    // Em produção: aliases + reindex zero-downtime
    // (ver runbooks/elasticsearch-reindex.md).
    // O client ES v9 tipa o body com uniões discriminadas (MappingProperty
    // etc.). Objetos-literais largam para `string` e não casam. Um único cast
    // explícito para IndicesCreateRequest é o escape-hatch idiomático aqui.
    await this.es.indices.create({
      index: EVENT_INDEX,
      ...EVENT_INDEX_MAPPING,
    } as estypes.IndicesCreateRequest);

    this.logger.log(`Índice "${EVENT_INDEX}" criado com mapping`);
  }
}
