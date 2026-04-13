// packages/types/src/auth.ts
// Schemas de autenticação — compartilhados entre auth-service e api-gateway

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const UserTypeSchema = z.enum(['organizer', 'buyer']);
export type UserType = z.infer<typeof UserTypeSchema>;

// ─── Login ────────────────────────────────────────────────────────────────────

export const LoginRequestSchema = z.object({
  // Zod 4: z.email() top-level (mais performático que z.string().email())
  email: z.email(),
  password: z.string().min(8),
  userType: UserTypeSchema,
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  // Refresh token vai em httpOnly cookie — não no body
  user: z.object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    type: UserTypeSchema,
  }),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

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
