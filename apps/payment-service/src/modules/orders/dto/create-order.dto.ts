// apps/payment-service/src/modules/orders/dto/create-order.dto.ts
//
// DTO do endpoint POST /payments/orders. Validação via Zod 4 antes de entrar
// na service — falhar cedo é cheaper que propagar dado inválido.

import { z } from 'zod';

export const CreateOrderSchema = z.object({
  // Uma ou mais reservas. O frontend tipicamente envia 1 (checkout por evento),
  // mas o contrato aceita múltiplas para permitir bundling no futuro.
  reservationIds: z.array(z.uuid()).min(1, 'Envie ao menos uma reserva'),
});

export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;
