// packages/types/src/auth.ts
// Schemas de autenticação — compartilhados entre auth-service e api-gateway

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const UserTypeSchema = z.enum(['organizer', 'buyer']);
export type UserType = z.infer<typeof UserTypeSchema>;

// ─── Login ────────────────────────────────────────────────────────────────────
//
// Contrato real do auth-service (ver apps/auth-service/src/modules/auth/auth.controller.ts):
//   - As rotas são separadas por tipo: /auth/organizers/login e /auth/buyers/login.
//     O tipo NÃO vai no body — está embutido na rota. Por isso LoginRequest
//     tem só email+password (sem userType).
//   - A resposta NÃO carrega o objeto `user`. Devolve apenas accessToken +
//     expiresIn (segundos). O refresh token vai em httpOnly cookie.
//   - Os dados do usuário (id/email/type/organizerId) saem do JWT decodificado
//     no client, não de um campo `user` no body.

export const LoginRequestSchema = z.object({
  // Zod 4: z.email() top-level (mais performático que z.string().email())
  email: z.email(),
  password: z.string().min(8),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  // Tempo de vida do access token em SEGUNDOS (auth-service emite 900 = 15min)
  expiresIn: z.number().int().positive(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// Resposta das rotas /auth/*/refresh — mesmo shape do login OU erro tipado.
export const RefreshResponseSchema = z.union([
  z.object({
    accessToken: z.string(),
    expiresIn: z.number().int().positive(),
  }),
  z.object({
    statusCode: z.number(),
    message: z.string(),
  }),
]);
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

// ─── JWT Payload ──────────────────────────────────────────────────────────────
// Estrutura do JWT após decodificação — injetado pelo api-gateway nos headers

export const JwtPayloadSchema = z.object({
  sub: z.uuid(),        // ID do usuário
  email: z.email(),
  type: UserTypeSchema,
  organizerId: z.uuid().optional(), // presente apenas para organizer_users
  iat: z.number(),
  exp: z.number(),
});
export type JwtPayload = z.infer<typeof JwtPayloadSchema>;
