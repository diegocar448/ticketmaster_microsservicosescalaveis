// packages/types/src/payments.ts
// Schemas de pagamento — compartilhados entre payment-service e frontend

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const OrderStatusSchema = z.enum([
  'pending',    // aguardando pagamento
  'paid',       // pago (Stripe confirmou)
  'refunded',   // reembolsado
  'failed',     // falhou
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

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
