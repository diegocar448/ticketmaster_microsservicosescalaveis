// apps/event-service/src/modules/categories/categories.controller.ts
//
// GET /categories é público (compradores precisam filtrar eventos por categoria).
// POST /categories exige OrganizerGuard (em produção seria @Roles('admin')).

import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CategoriesService } from './categories.service.js';
import { OrganizerGuard } from '../../common/guards/organizer.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CreateCategorySchema } from '@showpass/types';
import type { CreateCategoryDto } from '@showpass/types';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  // Público: usado pelo frontend público e pelo organizer ao criar evento
  @Get()
  list(): ReturnType<CategoriesService['list']> {
    return this.service.list();
  }

  @Post()
  @UseGuards(OrganizerGuard)
  create(
    @Body(new ZodValidationPipe(CreateCategorySchema)) dto: CreateCategoryDto,
  ): ReturnType<CategoriesService['create']> {
    return this.service.create(dto);
  }
}
