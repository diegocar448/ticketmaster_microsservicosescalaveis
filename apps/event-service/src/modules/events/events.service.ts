// apps/event-service/src/modules/events/events.service.ts
//
// Camada de negócio para eventos.
// Integra: repository (banco), cache (Redis), eventos de domínio (Kafka).
//
// Cache-Aside Pattern: ler do cache primeiro, popular no miss.
// Invalidação proativa na mudança de status (não esperar TTL expirar).

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import slugify from 'slugify';
import { EventsRepository } from './events.repository.js';
import type { EventCreated, EventWithDetails, EventPublic, EventList } from './events.repository.js';
import { EventStatusMachine } from './event-status.js';
import type { EventStatus } from './event-status.js';
import { KafkaProducerService } from '@showpass/kafka';
import { RedisService } from '@showpass/redis';
import { KAFKA_TOPICS } from '@showpass/types';
import type { CreateEventDto } from '@showpass/types';
import type { Event } from '../../prisma/generated/index.js';

type UpdatedEvent = Event;

// TTL do cache por status do evento:
// on_sale → curto (disponibilidade muda a todo momento com reservas sendo criadas)
// sold_out/completed → longo (dados estáticos — evento encerrado)
//
// satisfies Record<EventStatus, number> garante cobertura de todos os status em tempo de compilação
const CACHE_TTL = {
  draft:     60,
  published: 300,    // 5 minutos
  on_sale:   30,     // 30 segundos — quantidade disponível muda constantemente
  sold_out:  3600,   // 1 hora
  cancelled: 300,
  completed: 86400,  // 24 horas — evento encerrado
} as const satisfies Record<EventStatus, number>;

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly eventsRepo: EventsRepository,
    private readonly redis: RedisService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async create(organizerId: string, dto: CreateEventDto): Promise<EventCreated> {
    // Slug único = título normalizado + timestamp (evita colisões)
    const baseSlug = slugify(dto.title, { lower: true, strict: true });
    const slug = `${baseSlug}-${String(Date.now())}`;

    const event = await this.eventsRepo.create(organizerId, {
      ...dto,
      slug,
      venueCity: '',   // preenchido via VenuesService no fluxo completo
      venueState: '',
    });

    this.logger.log(`Evento criado: eventId=${event.id}, organizerId=${organizerId}`);

    return event;
  }

  async getById(id: string, organizerId?: string): Promise<EventWithDetails> {
    const event = await this.eventsRepo.findById(id, organizerId);
    if (!event) throw new NotFoundException('Evento não encontrado');
    return event;
  }

  /**
   * GET /events/:slug/public — rota pública de alta frequência.
   *
   * Cache-Aside Pattern:
   *   1. Verificar Redis → retorna em ~0.1ms (cache hit)
   *   2. Cache miss → buscar no Postgres → salvar no Redis → retornar
   *
   * Pico de 10M usuários: sem cache, o Postgres receberia milhões de req/s
   * para o mesmo dado estático. Com cache TTL=30s: apenas ~33 req/s chegam ao banco.
   */
  async getBySlug(slug: string): Promise<EventPublic> {
    const cacheKey = `event:slug:${slug}`;

    // Passo 1: tentar cache primeiro
    const cached = await this.redis.get<EventPublic>(cacheKey);
    if (cached) return cached;

    // Passo 2: cache miss — buscar no banco
    const event = await this.eventsRepo.findBySlug(slug);
    if (!event) throw new NotFoundException(`Evento '${slug}' não encontrado`);

    // Passo 3: popular cache com TTL baseado no status
    const ttl = CACHE_TTL[event.status as EventStatus];
    await this.redis.set(cacheKey, event, ttl);

    return event;
  }

  async listByOrganizer(
    organizerId: string,
    params: { status?: EventStatus; page: number; limit: number },
  ): Promise<EventList> {
    return this.eventsRepo.listByOrganizer(organizerId, params);
  }

  /**
   * Transição de status com três garantias:
   * 1. Máquina de estados — transições inválidas são rejeitadas com 400
   * 2. Cache invalidado — próxima leitura reflete o novo status imediatamente
   * 3. Evento Kafka emitido — Search Service indexa, Booking Service reage
   */
  async transitionStatus(
    id: string,
    organizerId: string,
    newStatus: EventStatus,
  ): Promise<UpdatedEvent> {
    const event = await this.eventsRepo.findById(id, organizerId);
    if (!event) throw new NotFoundException('Evento não encontrado');

    // Checagem redundante: findById já filtra por organizerId.
    // Mantida como defesa profunda (OWASP A01).
    if (event.organizerId !== organizerId) {
      throw new ForbiddenException('Sem permissão para alterar este evento');
    }

    try {
      EventStatusMachine.assertTransition(event.status as EventStatus, newStatus);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const updated = await this.eventsRepo.updateStatus(id, organizerId, newStatus);

    // Invalidar cache — próxima leitura recarregará dados atualizados
    await Promise.all([
      this.redis.del(`event:slug:${updated.slug}`),
      this.redis.del(`event:id:${updated.id}`),
    ]);

    // Notificar outros serviços via Kafka
    if (newStatus === 'on_sale') {
      await this.kafka.emit(
        KAFKA_TOPICS.EVENT_PUBLISHED,
        {
          eventId: event.id,
          organizerId: event.organizerId,
          title: event.title,
          startAt: event.startAt,
          venueCity: event.venueCity,
        },
        event.id,  // key = eventId → mesma partição = ordem garantida por evento
      );
    }

    if (newStatus === 'cancelled') {
      await this.kafka.emit(
        KAFKA_TOPICS.EVENT_CANCELLED,
        { eventId: event.id, organizerId: event.organizerId },
        event.id,
      );
    }

    return updated;
  }
}
