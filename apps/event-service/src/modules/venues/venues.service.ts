// apps/event-service/src/modules/venues/venues.service.ts
//
// Cria venues com seções e assentos gerados em bulk.
// Um teatro com 2000 assentos precisa de 2000 registros —
// fazer um por um levaria segundos. Bulk insert em chunks de 500: milissegundos.

import { Injectable, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Venue, Prisma } from '../../prisma/generated/index.js';
import type { CreateVenueDto } from '@showpass/types';

interface CreateSectionInput {
  name: string;
  seatingType: 'reserved' | 'general_admission';
  rows: string[];         // ["A", "B", "C", ...]
  seatsPerRow: number;
}

type SeatData = {
  sectionId: string;
  row: string;
  number: number;
  type: string;
  mapX: number;
  mapY: number;
};

@Injectable()
export class VenuesService {
  private readonly logger = new Logger(VenuesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(
    organizerId: string,
    dto: CreateVenueDto,
    sections: CreateSectionInput[],
  ): Promise<Venue> {
    // Verificar limite do plano antes de criar (SaaS plan gates)
    const organizer = await this.prisma.organizer.findUnique({
      where: { id: organizerId },
      include: { plan: true, venues: { select: { id: true } } },
    });

    if (!organizer) throw new NotFoundException('Organizer não encontrado');

    if (organizer.venues.length >= organizer.plan.maxVenues) {
      throw new ForbiddenException(
        `Limite do plano atingido: máximo de ${String(organizer.plan.maxVenues)} venues. ` +
        `Faça upgrade do seu plano para criar mais.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Criar o venue
      const venue = await tx.venue.create({
        data: {
          organizerId,
          name: dto.name,
          address: dto.address,
          city: dto.city,
          state: dto.state,
          zipCode: dto.zipCode,
          latitude: dto.latitude,
          longitude: dto.longitude,
          capacity: dto.capacity,
        },
      });

      // 2. Criar seções e assentos em bulk
      for (const section of sections) {
        const createdSection = await tx.section.create({
          data: {
            venueId: venue.id,
            name: section.name,
            seatingType: section.seatingType,
            capacity: section.rows.length * section.seatsPerRow,
          },
        });

        if (section.seatingType === 'reserved') {
          const seatsToCreate = this.generateSeats(
            createdSection.id,
            section.rows,
            section.seatsPerRow,
          );

          // Inserir em chunks de 500 — evita timeout e pressão de memória
          await this.bulkInsertSeats(tx, seatsToCreate);

          this.logger.log(
            `Seção "${section.name}": ${String(seatsToCreate.length)} assentos criados`,
          );
        }
      }

      return venue;
    });
  }

  /**
   * Gera os dados dos assentos para uma seção.
   * rows=["A","B","C"], seatsPerRow=20 → 60 assentos (A1..A20, B1..B20, C1..C20)
   */
  private generateSeats(
    sectionId: string,
    rows: string[],
    seatsPerRow: number,
  ): SeatData[] {
    const seats: SeatData[] = [];

    // for...of entries() evita noUncheckedIndexedAccess: row é string (não string | undefined)
    for (const [rowIndex, row] of rows.entries()) {
      for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
        seats.push({
          sectionId,
          row,
          number: seatNum,
          type: 'standard',
          // Coordenadas para renderização do mapa SVG no frontend
          // Cada assento = 30px, espaçamento = 5px → passo de 35px
          mapX: (seatNum - 1) * 35,
          mapY: rowIndex * 35,
        });
      }
    }

    return seats;
  }

  /**
   * Insere assentos em chunks para não sobrecarregar o banco.
   * createMany é O(1) em round-trips vs criar um por um O(n).
   */
  private async bulkInsertSeats(
    tx: Prisma.TransactionClient,
    seats: SeatData[],
    chunkSize = 500,
  ): Promise<void> {
    for (let i = 0; i < seats.length; i += chunkSize) {
      const chunk = seats.slice(i, i + chunkSize);
      await tx.seat.createMany({ data: chunk });
    }
  }
}
