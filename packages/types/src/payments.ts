// packages/types/src/payments.ts
// Schemas de pagamento — compartilhados entre payment-service e frontend

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const OrderStatusSchema = z.enum([
  'pending',
  'paid',
  'failed',
  'refunded',
  'partially_refunded',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const CreateOrderSchema = z.object({
  reservationIds: z.array(z.uuid()).min(1),
});
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;

// Resposta real de POST /payments/orders (ver
// apps/payment-service/src/modules/orders/orders.service.ts:createCheckout):
// devolve { orderId, checkoutUrl, status } — NÃO tem `id`, `total` nem
// `expiresAt`. A expiração relevante para o countdown vive na RESERVA
// (booking-service), não na order. O frontend busca o expiresAt via
// GET /bookings/reservations/:id quando precisa do timer.
export const CreateOrderResponseSchema = z.object({
  orderId: z.uuid(),
  checkoutUrl: z.url(),
  status: OrderStatusSchema,
});
export type CreateOrderResponse = z.infer<typeof CreateOrderResponseSchema>;

// Resposta de GET /payments/orders/:id (ver OrdersService.getOrder) —
// retorna o Order Prisma completo com items.
export const OrderResponseSchema = z.object({
  id: z.uuid(),
  buyerId: z.uuid(),
  organizerId: z.uuid(),
  eventId: z.uuid(),
  status: OrderStatusSchema,
  subtotal: z.coerce.number(),
  serviceFee: z.coerce.number(),
  total: z.coerce.number(),
  stripeCheckoutSessionId: z.string().nullable(),
  idempotencyKey: z.string(),
  paidAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  items: z.array(
    z.object({
      id: z.uuid(),
      reservationId: z.uuid(),
      ticketBatchId: z.uuid(),
      seatId: z.uuid().nullable(),
      unitPrice: z.coerce.number(),
      quantity: z.number().int(),
      total: z.coerce.number(),
    }),
  ),
});

export type OrderResponse = z.infer<typeof OrderResponseSchema>;


// ─── Checkout ─────────────────────────────────────────────────────────────────

export const CreateCheckoutRequestSchema = z.object({
  reservationId: z.uuid(),
  // successUrl e cancelUrl validados como URLs absolutas
  successUrl: z.url(),
  cancelUrl: z.url(),
});
export type CreateCheckoutRequest = z.infer<typeof CreateCheckoutRequestSchema>;

export const CreateCheckoutResponseSchema = z.object({
  checkoutUrl: z.url(),
  sessionId: z.string(),
});
export type CreateCheckoutResponse = z.infer<typeof CreateCheckoutResponseSchema>;
