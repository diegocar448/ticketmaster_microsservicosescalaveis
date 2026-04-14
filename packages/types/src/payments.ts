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

export const OrderResponseSchema = z.object({
  id: z.uuid(),
  status: OrderStatusSchema,
  total: z.number(),
  checkoutUrl: z.url(),
  expiresAt: z.coerce.date(),
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
