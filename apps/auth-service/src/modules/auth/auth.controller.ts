// apps/auth-service/src/modules/auth/auth.controller.ts
//
// Endpoints de autenticação para organizers e buyers.
//
// Segurança:
//   - Rate limiting por throttle tier "auth" — previne brute force (OWASP A07)
//   - Refresh token em httpOnly cookie — imune a XSS (OWASP A07)
//   - ZodValidationPipe valida e sanitiza o body de entrada (OWASP A03)

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { OrganizerAuthService } from './organizer-auth.service.js';
import { BuyerAuthService } from './buyer-auth.service.js';
import { TokenService } from './token.service.js';
import { OrganizerGuard } from '../../common/guards/organizer.guard.js';
import { CurrentUser, type AuthenticatedUser } from '@showpass/types';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { z } from 'zod';

// Zod 4: z.email() top-level (não z.string().email() que é deprecated)
// Ver CLAUDE.md: "Zod 4: usar z.uuid(), z.url(), z.email() top-level"
const LoginSchema = z.object({
  email: z.email(),
  // Mínimo 8 chars com maiúscula + minúscula + número — OWASP A07
  password: z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
});

type LoginDto = z.infer<typeof LoginSchema>;

const RegisterOrganizerSchema = z.object({
  name: z.string().min(2),
  email: z.email(),
  password: z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
  organizationName: z.string().min(2).optional(),
});

type RegisterOrganizerDto = z.infer<typeof RegisterOrganizerSchema>;

const RegisterBuyerSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.email(),
  password: z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
});

type RegisterBuyerDto = z.infer<typeof RegisterBuyerSchema>;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly organizerAuth: OrganizerAuthService,
    private readonly buyerAuth: BuyerAuthService,
    private readonly tokenService: TokenService,
  ) {}

  // ─── Organizer Auth ────────────────────────────────────────────────────────

  /** Registro de novo organizer. Cria organização + user em transação. */
  @Post('organizers/register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  async organizerRegister(
    @Body(new ZodValidationPipe(RegisterOrganizerSchema)) body: RegisterOrganizerDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const tokens = await this.organizerAuth.register({
      name: body.name,
      email: body.email,
      password: body.password,
      organizationName: body.organizationName ?? body.name,
    });

    this.setRefreshTokenCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  /**
   * Login de organizer.
   * Rate limit: 5 tentativas/min por IP — previne brute force (OWASP A07)
   */
  @Post('organizers/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  async organizerLogin(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const tokens = await this.organizerAuth.login(body.email, body.password, {
      userAgent: req.headers['user-agent'] ?? undefined,
      ipAddress: req.ip ?? undefined,
    });

    // Refresh token em httpOnly cookie — imune a XSS
    this.setRefreshTokenCookie(res, tokens.refreshToken);

    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
    };
  }

  /** Perfil do organizer autenticado */
  @Get('organizers/me')
  @UseGuards(OrganizerGuard)
  // Sem async: apenas retorna o usuário injetado pelo guard — sem operação assíncrona
  organizerMe(
    @CurrentUser() user: AuthenticatedUser,
  ): AuthenticatedUser {
    return user;
  }

  // ─── Token Refresh ─────────────────────────────────────────────────────────

  @Post('organizers/refresh')
  @HttpCode(HttpStatus.OK)
  async organizerRefresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ statusCode: number; message: string } | { accessToken: string; expiresIn: number }> {
    return this.refreshTokens(req, res);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ statusCode: number; message: string } | { accessToken: string; expiresIn: number }> {
    return this.refreshTokens(req, res);
  }

  // ─── Logout ────────────────────────────────────────────────────────────────

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(OrganizerGuard)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- necessário para documentação do endpoint
    @CurrentUser() _user: AuthenticatedUser,
  ): Promise<void> {
    const rawToken = req.cookies['refresh_token'] as string | undefined;

    if (rawToken) {
      await this.tokenService.revoke(rawToken);
    }

    res.clearCookie('refresh_token');
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(OrganizerGuard)
  async logoutAll(
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.tokenService.revokeAll(user.id, 'organizer');
    res.clearCookie('refresh_token');
  }

  // ─── Buyer Auth ────────────────────────────────────────────────────────────

  /** Registro de novo buyer. */
  @Post('buyers/register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  async buyerRegister(
    @Body(new ZodValidationPipe(RegisterBuyerSchema)) body: RegisterBuyerDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const tokens = await this.buyerAuth.register({
      // exactOptionalPropertyTypes: omitir chave quando undefined (não passar undefined)
      ...(body.name !== undefined ? { name: body.name } : {}),
      email: body.email,
      password: body.password,
    });

    this.setRefreshTokenCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Post('buyers/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 8, ttl: 60_000 } })
  async buyerLoginV2(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    return this.buyerLoginInternal(body, req, res);
  }

  @Post('buyer/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 8, ttl: 60_000 } })
  async buyerLogin(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    return this.buyerLoginInternal(body, req, res);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async buyerLoginInternal(
    body: LoginDto,
    req: Request,
    res: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const tokens = await this.buyerAuth.login(body.email, body.password, {
      userAgent: req.headers['user-agent'] ?? undefined,
      ipAddress: req.ip ?? undefined,
    });
    this.setRefreshTokenCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  private async refreshTokens(
    req: Request,
    res: Response,
  ): Promise<{ statusCode: number; message: string } | { accessToken: string; expiresIn: number }> {
    const rawToken = req.cookies['refresh_token'] as string | undefined;
    if (!rawToken) return { statusCode: 401, message: 'Refresh token não fornecido' };

    const newTokens = await this.tokenService.rotate(rawToken, {
      userAgent: req.headers['user-agent'] ?? undefined,
      ipAddress: req.ip ?? undefined,
    });

    if (!newTokens) {
      res.clearCookie('refresh_token');
      return { statusCode: 401, message: 'Token inválido ou expirado' };
    }

    this.setRefreshTokenCookie(res, newTokens.refreshToken);
    return { accessToken: newTokens.accessToken, expiresIn: newTokens.expiresIn };
  }

  private setRefreshTokenCookie(res: Response, token: string): void {
    res.cookie('refresh_token', token, {
      httpOnly: true,          // JavaScript não consegue ler — imune a XSS
      secure: process.env['NODE_ENV'] === 'production',  // HTTPS em produção
      sameSite: 'strict',      // Previne CSRF
      maxAge: 30 * 24 * 60 * 60 * 1000,  // 30 dias em ms
      path: '/auth',           // Cookie só enviado para /auth — scope mínimo
    });
  }
}
