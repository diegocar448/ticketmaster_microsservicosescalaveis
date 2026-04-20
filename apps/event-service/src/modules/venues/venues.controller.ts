// apps/event-service/src/modules/venues/venues.controller.ts
//
// Rotas para gerenciamento de venues (locais de eventos).
// O cap-05 gera ~78k assentos com bulk insert em milissegundos.

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { VenuesService } from './venues.service.js';
import { OrganizerGuard } from '../../common/guards/organizer.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  CreateVenueWithSectionsSchema,
  CurrentUser,
} from '@showpass/types';
import type {
  AuthenticatedUser,
  CreateVenueWithSectionsDto,
} from '@showpass/types';

@Controller('venues')
@UseGuards(OrganizerGuard)
export class VenuesController {
  constructor(private readonly venuesService: VenuesService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateVenueWithSectionsSchema))
    dto: CreateVenueWithSectionsDto,
  ): ReturnType<VenuesService['create']> {
    const organizerId = this.assertOrganizerId(user);

    // Separar os campos "do venue" dos "das seções" — service tem assinatura distinta
    const { sections, ...venueDto } = dto;

    return this.venuesService.create(
      organizerId,
      venueDto,
      sections.map((s) => ({
        name: s.name,
        seatingType: s.seatingType,
        rows: s.rows ?? [],
        seatsPerRow: s.seatsPerRow ?? 0,
      })),
    );
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
  ): ReturnType<VenuesService['listByOrganizer']> {
    return this.venuesService.listByOrganizer(this.assertOrganizerId(user));
  }

  @Get(':id')
  getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): ReturnType<VenuesService['getById']> {
    return this.venuesService.getById(id, this.assertOrganizerId(user));
  }

  private assertOrganizerId(user: AuthenticatedUser): string {
    const id = user.organizerId;
    if (!id) throw new ForbiddenException('Organizer ID ausente no header x-organizer-id');
    return id;
  }
}
