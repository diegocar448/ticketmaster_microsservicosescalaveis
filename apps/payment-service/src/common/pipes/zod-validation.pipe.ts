// apps/payment-service/src/common/pipes/zod-validation.pipe.ts
//
// Pipe NestJS que valida o body usando um Zod schema. Idêntico ao de
// booking-service — duplicação intencional (cada serviço é independente).

import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Zod 4 usa .issues (renomeado de .errors em v3)
      const errors = result.error.issues.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));

      throw new BadRequestException({
        message: 'Dados de entrada inválidos',
        errors,
      });
    }

    return result.data;
  }
}
