// apps/event-service/src/modules/categories/categories.service.ts
//
// Categorias são globais (não pertencem a organizer): "Shows", "Teatro", etc.
// O seed popula as iniciais; este service apenas expõe leitura e permite
// adicionar novas (protegido por OrganizerGuard — qualquer organizer pode criar).

import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Category } from '../../prisma/generated/index.js';
import type { CreateCategoryDto } from '@showpass/types';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<Category[]> {
    return this.prisma.category.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateCategoryDto): Promise<Category> {
    // slug é @unique no schema → conflict sinaliza tentativa duplicada
    const existing = await this.prisma.category.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new ConflictException(`Categoria com slug '${dto.slug}' já existe`);
    }

    return this.prisma.category.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        icon: dto.icon ?? null,
      },
    });
  }
}
