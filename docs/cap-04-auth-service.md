# Capítulo 4 — Auth Service

> **Objetivo:** Implementar autenticação JWT com RS256, dois tipos de usuário (organizer e buyer), refresh token rotation, Guards NestJS, e proteção contra brute force.

## O que você vai aprender

- JWT com RS256 (assimétrico) — por que é superior ao HS256 para microserviços
- Access Token (15min) + Refresh Token rotation — padrão de segurança do Google/Meta
- Dois guards: `OrganizerGuard` e `BuyerGuard` — sem misturar contextos
- Decoradores personalizados `@CurrentUser()` — acesso limpo ao usuário autenticado
- Bcrypt com custo adaptativo — OWASP A02
- Refresh token armazenado em httpOnly cookie — imune a XSS

---

## JWT RS256 vs HS256 — Por que importa em microserviços

```
HS256 (simétrico):
  Auth Service ──── mesma chave secreta ────→ Event Service
  Problema: qualquer serviço com a chave pode EMITIR tokens
  → comprometer um serviço = comprometer todos

RS256 (assimétrico):
  Auth Service ──── chave PRIVADA ────→ assina tokens
  Event Service ─── chave PÚBLICA ───→ apenas VERIFICA tokens
  → comprometer Event Service NÃO permite emitir tokens
```

---

## Passo 4.1 — Gerar par de chaves RSA

```bash
# Gerar chave privada RSA 4096-bit (auth-service guarda)
openssl genrsa -out apps/auth-service/keys/private.pem 4096

# Extrair chave pública (distribuída para todos os serviços)
openssl rsa -in apps/auth-service/keys/private.pem \
            -pubout \
            -out packages/types/keys/public.pem

# Nunca commitar a chave privada — adicionar ao .gitignore
echo "apps/auth-service/keys/private.pem" >> .gitignore
```

---

## Passo 4.2 — Schema Prisma do Auth Service

```prisma
// apps/auth-service/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
  output   = "../src/prisma/generated"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Refresh tokens — armazenados no banco para permitir revogação
// Quando o usuário faz logout, o token é invalidado aqui
model RefreshToken {
  id String @id @default(uuid()) @db.Uuid

  // Polimórfico: pode pertencer a OrganizerUser ou Buyer
  tokenableId   String @db.Uuid
  tokenableType String  // "organizer_user" | "buyer"

  // Hash do token (nunca armazenar o token em texto plano)
  tokenHash String @unique

  // Metadados para auditoria e revogação
  userAgent  String?
  ipAddress  String?
  expiresAt  DateTime
  revokedAt  DateTime?
  lastUsedAt DateTime?

  createdAt DateTime @default(now())

  @@index([tokenableId, tokenableType])
  @@map("refresh_tokens")
}

// Email verification tokens
model EmailVerification {
  id           String   @id @default(uuid()) @db.Uuid
  userId       String   @db.Uuid
  userType     String   // "organizer_user" | "buyer"
  tokenHash    String   @unique
  expiresAt    DateTime
  verifiedAt   DateTime?
  createdAt    DateTime @default(now())

  @@map("email_verifications")
}
```

---

## Passo 4.3 — JWT Strategy

```typescript
// apps/auth-service/src/modules/auth/strategies/jwt.strategy.ts
//
// Configura o passport-jwt para verificar tokens RS256.
// Esta estratégia é usada no próprio auth-service para
// endpoints protegidos (ex: logout, refresh).

import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface JwtPayload {
  sub: string;           // user ID
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
  iat: number;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      // Extrair token do header Authorization: Bearer <token>
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Chave pública para verificar assinatura RS256
      secretOrKey: readFileSync(join(__dirname, '../../../../keys/public.pem')),
      algorithms: ['RS256'],
      audience: 'showpass-api',
      issuer: 'showpass-auth',
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    // O que retornar aqui é injetado em req.user
    return payload;
  }
}
```

---

## Passo 4.4 — Token Service

```typescript
// apps/auth-service/src/modules/auth/token.service.ts
//
// Responsável pela emissão e validação de tokens.
// Access Token: 15 minutos — curto para limitar janela de comprometimento
// Refresh Token: 30 dias — armazenado como hash no banco + httpOnly cookie

import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { createHash, randomBytes } from 'crypto';
import type { JwtPayload } from './strategies/jwt.strategy';

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
    meta: { userAgent?: string; ipAddress?: string },
  ): Promise<TokenPair> {
    // ─── 1. Access Token (JWT, curto) ─────────────────────────────────────────
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: ctx.userId,
      email: ctx.email,
      type: ctx.type,
      organizerId: ctx.organizerId,
    };

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

    await this.prisma.refreshToken.create({
      data: {
        tokenableId: ctx.userId,
        tokenableType: ctx.type === 'organizer' ? 'organizer_user' : 'buyer',
        tokenHash,
        userAgent: meta.userAgent,
        ipAddress: meta.ipAddress,
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
    meta: { userAgent?: string; ipAddress?: string },
  ): Promise<TokenPair | null> {
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');

    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!storedToken) {
      this.logger.warn('Refresh token não encontrado', { tokenHash: tokenHash.substring(0, 8) });
      return null;
    }

    // ─── Detectar reuso (token theft detection) ────────────────────────────────
    if (storedToken.revokedAt) {
      this.logger.error('ALERTA: Refresh token reutilizado — possível roubo!', {
        userId: storedToken.tokenableId,
        tokenHash: tokenHash.substring(0, 8),
      });

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
    const type = storedToken.tokenableType === 'organizer_user' ? 'organizer' : 'buyer';

    // Buscar informações do usuário para reemitir o token
    // (organizerId pode ter mudado — sempre buscar do banco)
    const userCtx = await this.getUserContext(storedToken.tokenableId, type);
    if (!userCtx) return null;

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

  private async getUserContext(
    userId: string,
    type: 'organizer' | 'buyer',
  ): Promise<AuthContext | null> {
    // Implementado no AuthService — injetado via DI para evitar ciclo
    // Retornado como interface para não criar dependência circular
    return null;  // Implementação no AuthService
  }
}
```

---

## Passo 4.5 — Auth Service (Organizers)

```typescript
// apps/auth-service/src/modules/auth/organizer-auth.service.ts

import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from './token.service';
import type { TokenPair } from './token.service';

// OWASP A02: custo 12 — ~300ms em hardware moderno
// Equilibrio entre segurança e performance (não bloquear event loop)
const BCRYPT_ROUNDS = 12;

export interface RegisterOrganizerDto {
  name: string;
  email: string;
  password: string;
  organizationName: string;
}

@Injectable()
export class OrganizerAuthService {
  private readonly logger = new Logger(OrganizerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async register(dto: RegisterOrganizerDto): Promise<TokenPair> {
    // Verificar se email já existe
    const existing = await this.prisma.organizerUser.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      // OWASP A07: não revelar se o email existe ou não
      // Mas aqui estamos no endpoint de registro — revelar conflito é aceitável
      throw new ConflictException('Este e-mail já está em uso');
    }

    // Hash da senha com bcrypt
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Buscar plano gratuito para novos organizadores
    const freePlan = await this.prisma.plan.findUniqueOrThrow({
      where: { slug: 'free' },
    });

    // Criar organizer + user em transação atômica
    const user = await this.prisma.$transaction(async (tx) => {
      const organizer = await tx.organizer.create({
        data: {
          name: dto.organizationName,
          slug: this.slugify(dto.organizationName),
          planId: freePlan.id,
          // Trial de 14 dias no plano Pro
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });

      return tx.organizerUser.create({
        data: {
          organizerId: organizer.id,
          name: dto.name,
          email: dto.email,
          passwordHash,
          role: 'owner',
        },
      });
    });

    this.logger.log('Novo organizer registrado', { userId: user.id });

    return this.tokenService.issueTokenPair(
      {
        userId: user.id,
        email: user.email,
        type: 'organizer',
        organizerId: user.organizerId,
      },
      {},
    );
  }

  async login(
    email: string,
    password: string,
    meta: { userAgent?: string; ipAddress?: string },
  ): Promise<TokenPair> {
    const user = await this.prisma.organizerUser.findUnique({
      where: { email },
    });

    // OWASP A07: tempo constante — não revelar se email existe
    // Mesmo que não encontre o usuário, executar o compare para
    // gastar o mesmo tempo (previne timing attack)
    const passwordToCompare = user?.passwordHash ?? '$2b$12$invalidhashfortimingreason';
    const isValid = await bcrypt.compare(password, passwordToCompare);

    if (!user || !isValid) {
      this.logger.warn('Tentativa de login falhou', { email, ip: meta.ipAddress });
      throw new UnauthorizedException('E-mail ou senha incorretos');
    }

    await this.prisma.organizerUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.tokenService.issueTokenPair(
      {
        userId: user.id,
        email: user.email,
        type: 'organizer',
        organizerId: user.organizerId,
      },
      meta,
    );
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
```

---

## Passo 4.6 — Guards NestJS

```typescript
// apps/auth-service/src/common/guards/organizer.guard.ts
//
// Protege endpoints que só podem ser acessados por organizers.
// Extrai x-user-id e x-organizer-id das headers (injetados pelo Gateway).
// NÃO valida JWT — isso já foi feito no Gateway.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class OrganizerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const userId = request.headers['x-user-id'];
    const userType = request.headers['x-user-type'];
    const organizerId = request.headers['x-organizer-id'];

    if (!userId) {
      throw new UnauthorizedException('Não autenticado');
    }

    if (userType !== 'organizer') {
      throw new ForbiddenException('Acesso exclusivo para organizadores');
    }

    if (!organizerId) {
      throw new ForbiddenException('Organizador não associado ao usuário');
    }

    return true;
  }
}
```

```typescript
// apps/auth-service/src/common/guards/buyer.guard.ts

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class BuyerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const userId = request.headers['x-user-id'];
    const userType = request.headers['x-user-type'];

    if (!userId) {
      throw new UnauthorizedException('Não autenticado');
    }

    if (userType !== 'buyer') {
      throw new ForbiddenException('Acesso exclusivo para compradores');
    }

    return true;
  }
}
```

---

## Passo 4.7 — Decoradores `@CurrentUser()`

```typescript
// packages/types/src/decorators/current-user.decorator.ts
//
// Extrai o usuário autenticado do contexto da request.
// Elimina o boilerplate de acessar headers manualmente em cada controller.
//
// Uso:
//   @Get('profile')
//   @UseGuards(OrganizerGuard)
//   getProfile(@CurrentUser() user: AuthenticatedUser) { ... }

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request>();

    return {
      id: request.headers['x-user-id'] as string,
      email: request.headers['x-user-email'] as string,
      type: request.headers['x-user-type'] as 'organizer' | 'buyer',
      organizerId: request.headers['x-organizer-id'] as string | undefined,
    };
  },
);
```

---

## Passo 4.8 — Auth Controller

```typescript
// apps/auth-service/src/modules/auth/auth.controller.ts

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { OrganizerAuthService } from './organizer-auth.service';
import { BuyerAuthService } from './buyer-auth.service';
import { TokenService } from './token.service';
import { OrganizerGuard } from '../../common/guards/organizer.guard';
import { CurrentUser, type AuthenticatedUser } from '@showpass/types';

// ─── DTOs com Zod Pipe ────────────────────────────────────────────────────────
// (ZodValidationPipe converte o Zod schema em um NestJS pipe)
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { z } from 'zod';

const LoginSchema = z.object({
  email: z.string().email(),
  // Mínimo 8 chars: maiúscula + minúscula + número — OWASP A07
  password: z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly organizerAuth: OrganizerAuthService,
    private readonly buyerAuth: BuyerAuthService,
    private readonly tokenService: TokenService,
  ) {}

  // ─── Organizer Auth ────────────────────────────────────────────────────────

  /**
   * Login de organizer.
   * Rate limit: 5 tentativas/min por IP — previne brute force (OWASP A07)
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  async organizerLogin(
    @Body(new ZodValidationPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.organizerAuth.login(body.email, body.password, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    // Refresh token em httpOnly cookie — imune a XSS
    this.setRefreshTokenCookie(res, tokens.refreshToken);

    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
    };
  }

  // ─── Token Refresh ─────────────────────────────────────────────────────────

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Ler refresh token do httpOnly cookie
    const rawToken = req.cookies['refresh_token'] as string | undefined;

    if (!rawToken) {
      return { statusCode: 401, message: 'Refresh token não fornecido' };
    }

    const newTokens = await this.tokenService.rotate(rawToken, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    if (!newTokens) {
      // Limpar cookie inválido
      res.clearCookie('refresh_token');
      return { statusCode: 401, message: 'Token inválido ou expirado' };
    }

    this.setRefreshTokenCookie(res, newTokens.refreshToken);

    return {
      accessToken: newTokens.accessToken,
      expiresIn: newTokens.expiresIn,
    };
  }

  // ─── Logout ────────────────────────────────────────────────────────────────

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(OrganizerGuard)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: AuthenticatedUser,
  ) {
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
  ) {
    await this.tokenService.revokeAll(user.id, 'organizer');
    res.clearCookie('refresh_token');
  }

  // ─── Buyer Auth ────────────────────────────────────────────────────────────

  @Post('buyer/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 8, ttl: 60_000 } })  // buyers têm limite mais alto
  async buyerLogin(
    @Body(new ZodValidationPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.buyerAuth.login(body.email, body.password, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    this.setRefreshTokenCookie(res, tokens.refreshToken);

    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private setRefreshTokenCookie(res: Response, token: string): void {
    res.cookie('refresh_token', token, {
      httpOnly: true,          // JavaScript não consegue ler — imune a XSS
      secure: process.env.NODE_ENV === 'production',  // HTTPS em produção
      sameSite: 'strict',      // Previne CSRF
      maxAge: 30 * 24 * 60 * 60 * 1000,  // 30 dias em ms
      path: '/auth',           // Cookie só enviado para /auth — scope mínimo
    });
  }
}
```

---

## Passo 4.9 — Zod Validation Pipe

```typescript
// apps/auth-service/src/common/pipes/zod-validation.pipe.ts
//
// Pipe NestJS que valida o body usando um Zod schema.
// Se inválido: retorna 422 com erros detalhados (mas seguros).
// Não expõe nada sobre a implementação — apenas erros de validação.

import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Formatar os erros do Zod em formato legível
      const errors = (result.error as ZodError).errors.map((e) => ({
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
```

---

## Fluxo de autenticação completo

```
1. Login (POST /auth/login)
   ├── Validar email/password com Zod
   ├── Bcrypt.compare (timing constante — OWASP A07)
   ├── Emitir Access Token (JWT RS256, 15min)
   ├── Emitir Refresh Token (256 bits, armazenar hash)
   └── Retorno: { accessToken } + cookie httpOnly (refresh_token)

2. Request autenticada
   ├── Gateway valida JWT RS256 com chave pública
   ├── Injeta x-user-id, x-user-type, x-organizer-id nos headers
   └── Serviço downstream usa OrganizerGuard / BuyerGuard

3. Token expirado (POST /auth/refresh)
   ├── Ler refresh_token do cookie httpOnly
   ├── Buscar hash no banco
   ├── Detectar reuso? → revogar TODOS os tokens (theft detection)
   ├── Revogar token atual (rotation)
   └── Emitir novo par de tokens

4. Logout (POST /auth/logout)
   ├── Revogar refresh token no banco
   └── Limpar cookie
```

---

## Recapitulando

1. **JWT RS256 assimétrico** — chave privada apenas no auth-service; serviços só verificam
2. **Access Token 15min + Refresh Token 30 dias** com rotation — padrão Google/Meta
3. **Refresh token theft detection** — reuso detectado revoga TODOS os tokens do usuário
4. **httpOnly cookie** para o refresh token — imune a ataques XSS
5. **Bcrypt custo 12** com timing constante — previne timing attack e brute force
6. **OrganizerGuard / BuyerGuard** — contextos completamente separados, sem misturar

---

## Próximo capítulo

[Capítulo 5 → Event Service](cap-05-event-service.md)
