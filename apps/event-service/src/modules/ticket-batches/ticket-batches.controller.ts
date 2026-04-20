// apps/event-service/src/modules/ticket-batches/ticket-batches.controller.ts
//
// Rotas aninhadas em /events/:eventId/ticket-batches para deixar clara a
// hierarquia: um batch SEMPRE pertence a um evento.

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TicketBatchesService } from './ticket-batches.service.js';
import { OrganizerGuard } from '../../common/guards/organizer.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  CreateTicketBatchSchema,
  UpdateTicketBatchSchema,
  CurrentUser,
} from '@showpass/types';
import type {
  AuthenticatedUser,
  CreateTicketBatchDto,
  UpdateTicketBatchDto,
} from '@showpass/types';

@Controller('events/:eventId/ticket-batches')
@UseGuards(OrganizerGuard)
export class TicketBatchesController {
  constructor(private readonly service: TicketBatchesService) {}

  @Post()
  create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateTicketBatchSchema)) dto: CreateTicketBatchDto,
  ): ReturnType<TicketBatchesService['create']> {
    return this.service.create(eventId, this.assertOrganizerId(user), dto);
  }

  @Get()
  list(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): ReturnType<TicketBatchesService['list']> {
    return this.service.list(eventId, this.assertOrganizerId(user));
  }

  @Get(':batchId')
  getById(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): ReturnType<TicketBatchesService['getById']> {
    return this.service.getById(batchId, this.assertOrganizerId(user));
  }

  @Patch(':batchId')
  update(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateTicketBatchSchema)) dto: UpdateTicketBatchDto,
  ): ReturnType<TicketBatchesService['update']> {
    return this.service.update(batchId, this.assertOrganizerId(user), dto);
  }

  @Delete(':batchId')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): ReturnType<TicketBatchesService['delete']> {
    return this.service.delete(batchId, this.assertOrganizerId(user));
  }

  private assertOrganizerId(user: AuthenticatedUser): string {
    const id = user.organizerId;
    if (!id) throw new ForbiddenException('Organizer ID ausente no header x-organizer-id');
    return id;
  }
}
