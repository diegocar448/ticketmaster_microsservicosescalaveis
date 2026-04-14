// apps/auth-service/src/modules/auth/token.service.ts
//
// Responsável pela emissão e validação de tokens.
// Access Token: 15 minutos — curto para limitar janela de comprometimento
// Refresh Token: 30 dias — armazenado como hash no banco + httpOnly cookie
//
// Refresh Token Rotation (padrão Google/Meta):
//   Cada uso do refresh token o invalida e emite um novo.
//   Se o token antigo for reutilizado → todos os tokens do usuário são revogados.

import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service.js';
import { createHash, randomBytes } from 'node:crypto';
import type { JwtPayload } from './strategies/jwt.strategy.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthContext {
  userId: string;
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Emite um par de tokens para o usuário autenticado.
   * Access token: JWT RS256, 15 minutos
   * Refresh token: bytes aleatórios, 30 dias, armazenado como hash
   */
  async issueTokenPair(
    ctx: AuthContext,
    // exactOptionalPropertyTypes: usar undefined explícito para aceitar req.headers que pode ser undefined
    meta: { userAgent?: string | undefined; ipAddress?: string | undefined },
  ): Promise<TokenPair> {
    // ─── 1. Access Token (JWT, curto) ─────────────────────────────────────────
    // exactOptionalPropertyTypes: construir payload sem organizerId quando ausente
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: ctx.userId,
      email: ctx.email,
      type: ctx.type,
    };

    if (ctx.organizerId !== undefined) {
      payload.organizerId = ctx.organizerId;
    }

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: '15m',
      algorithm: 'RS256',
    });

    // ─── 2. Refresh Token (opaque, longo) ─────────────────────────────────────
    // 256 bits de entropia — impossível de adivinhar
    const rawRefreshToken = randomBytes(32).toString('hex');

    // Armazenar apenas o hash — se o banco vazar, tokens são inúteis
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias

    // Prisma espera null (não undefined) para campos opcionais nullable
    await this.prisma.refreshToken.create({
      data: {
        tokenableId: ctx.userId,
        tokenableType: ctx.type === 'organizer' ? 'organizer_user' : 'buyer',
        tokenHash,
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ipAddress ?? null,
        expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: 15 * 60,  // segundos
    };
  }

  /**
   * Refresh Token Rotation:
   * Troca o refresh token antigo por um novo par.
   *
   * Rotation garante que:
   * 1. Se um token for roubado e usado, o token legítimo para de funcionar
   * 2. O sistema detecta o reuso e revoga TODOS os tokens do usuário
   * (padrão usado pelo Google, Netflix, Meta)
   */
  async rotate(
    rawRefreshToken: string,
    meta: { userAgent?: string | undefined; ipAddress?: string | undefined },
  ): Promise<TokenPair | null> {
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');

    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!storedToken) {
      this.logger.warn(`Refresh token não encontrado: ${tokenHash.substring(0, 8)}`);
      return null;
    }

    // ─── Detectar reuso (token theft detection) ────────────────────────────────
    if (storedToken.revokedAt) {
      this.logger.error(
        `ALERTA: Refresh token reutilizado — possível roubo! userId=${storedToken.tokenableId}`,
      );

      // Revogar TODOS os tokens do usuário — forçar novo login
      await this.prisma.refreshToken.updateMany({
        where: {
          tokenableId: storedToken.tokenableId,
          tokenableType: storedToken.tokenableType,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });

      return null;
    }

    if (storedToken.expiresAt < new Date()) {
      this.logger.warn('Refresh token expirado');
      return null;
    }

    // ─── Revogar token atual (rotation) ───────────────────────────────────────
    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: {
        revokedAt: new Date(),
        lastUsedAt: new Date(),
      },
    });

    // Determinar o tipo de usuário e reconstruir o contexto
    const type: 'organizer' | 'buyer' =
      storedToken.tokenableType === 'organizer_user' ? 'organizer' : 'buyer';

    // Buscar informações do usuário para reemitir o token
    // Nesta fase (Cap 4), rotate() emite para o mesmo usuário sem buscar dados extras
    // Cap 5 expande isso com a busca real de email/organizerId no banco
    const userCtx: AuthContext = {
      userId: storedToken.tokenableId,
      email: '',  // será preenchido via join com OrganizerUser/Buyer em Cap 5
      type,
    };

    // ─── Emitir novo par ───────────────────────────────────────────────────────
    return this.issueTokenPair(userCtx, meta);
  }

  /**
   * Revoga um refresh token específico (logout de um dispositivo).
   */
  async revoke(rawRefreshToken: string): Promise<void> {
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');

    await this.prisma.refreshToken.updateMany({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revoga todos os refresh tokens do usuário (logout de todos os dispositivos).
   */
  async revokeAll(userId: string, type: 'organizer' | 'buyer'): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: {
        tokenableId: userId,
        tokenableType: type === 'organizer' ? 'organizer_user' : 'buyer',
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

}
