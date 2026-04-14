// apps/auth-service/src/common/pipes/zod-validation.pipe.ts
//
// Pipe NestJS que valida o body usando um Zod schema.
// Se inválido: retorna 400 com erros detalhados (mas seguros — não expõe implementação).
//
// Por que Zod em vez de class-validator?
//   Zod schemas são compartilháveis entre frontend e backend via @showpass/types.
//   class-validator usa decoradores e não pode ser importado em código não-NestJS.

import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Zod 4 usa .issues (renomeado de .errors em v3)
      // Não tipar `e` explicitamente — inferido como core.$ZodIssue
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
