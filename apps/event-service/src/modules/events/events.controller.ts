// apps/event-service/src/modules/events/events.controller.ts
//
// Rotas HTTP para gerenciamento de eventos.
// Separação clara:
//   - Rotas públicas (sem guard): leitura por slug para compradores
//   - Rotas de organizer (com OrganizerGuard): CRUD restrito ao tenant

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { EventsService } from './events.service.js';
import { OrganizerGuard } from '../../common/guards/organizer.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUser, CreateEventSchema } from '@showpass/types';
import type { AuthenticatedUser, CreateEventDto, EventStatus } from '@showpass/types';

// Transições possíveis via API (draft não é transitável via request externo)
const TransitionStatusSchema = z.object({
  status: z.enum(['published', 'on_sale', 'sold_out', 'cancelled', 'completed']),
});

type TransitionStatusDto = z.infer<typeof TransitionStatusSchema>;

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  // ─── Rotas públicas ────────────────────────────────────────────────────────

  /**
   * Página pública do evento — usado pelo frontend na compra de ingressos.
   * Cache Redis ativo (TTL varia por status do evento).
   */
  @Get(':slug/public')
  getBySlug(@Param('slug') slug: string): ReturnType<EventsService['getBySlug']> {
    return this.eventsService.getBySlug(slug);
  }

  // ─── Rotas de organizer ────────────────────────────────────────────────────

  @Post()
  @UseGuards(OrganizerGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateEventSchema)) dto: CreateEventDto,
  ): ReturnType<EventsService['create']> {
    return this.eventsService.create(this.assertOrganizerId(user), dto);
  }

  @Get()
  @UseGuards(OrganizerGuard)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ): ReturnType<EventsService['listByOrganizer']> {
    // Spread condicional: exactOptionalPropertyTypes não aceita status: undefined explícito
    return this.eventsService.listByOrganizer(this.assertOrganizerId(user), {
      ...(status !== undefined ? { status: status as EventStatus } : {}),
      page: Number(page),
      limit: Math.min(Number(limit), 100),  // máximo 100 itens por página
    });
  }

  @Get(':id')
  @UseGuards(OrganizerGuard)
  getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): ReturnType<EventsService['getById']> {
    // Passar organizerId garante tenant isolation — não pode ver evento de outro organizer
    return this.eventsService.getById(id, this.assertOrganizerId(user));
  }

  @Patch(':id/status')
  @UseGuards(OrganizerGuard)
  transitionStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(TransitionStatusSchema)) body: TransitionStatusDto,
  ): ReturnType<EventsService['transitionStatus']> {
    return this.eventsService.transitionStatus(
      id,
      this.assertOrganizerId(user),
      body.status,
    );
  }

  /**
   * Extrai organizerId com segurança — OrganizerGuard já garante que está presente,
   * mas TypeScript não sabe disso (organizerId?: string na interface AuthenticatedUser).
   */
  private assertOrganizerId(user: AuthenticatedUser): string {
    const id = user.organizerId;
    if (!id) throw new ForbiddenException('Organizer ID ausente no header x-organizer-id');
    return id;
  }
}
