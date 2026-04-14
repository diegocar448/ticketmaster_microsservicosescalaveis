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
# Criar diretório de chaves
mkdir -p apps/auth-service/keys packages/types/keys

# Gerar chave privada RSA 4096-bit (auth-service guarda)
openssl genrsa -out apps/auth-service/keys/private.pem 4096

# Extrair chave pública (distribuída para todos os serviços)
openssl rsa -in apps/auth-service/keys/private.pem \
            -pubout \
            -out packages/types/keys/public.pem
```

> O `.gitignore` já contém `**/*.pem` que ignora ambas as chaves automaticamente.
> Nunca commitar chaves RSA — em produção, injetar via secrets do K8s.

---

## Passo 4.2 — Schema Prisma do Auth Service

> **Prisma 7:** A propriedade `url` foi removida do bloco `datasource`.
> A URL de conexão agora vai em `prisma.config.ts` (ver abaixo).

```prisma
// apps/auth-service/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
  output   = "../src/prisma/generated"
}

// Prisma 7: datasource sem url — configurado em prisma.config.ts
datasource db {
  provider = "postgresql"
}

// ─── Planos de organizer ───────────────────────────────────────────────────────

model Plan {
  id         String      @id @default(uuid()) @db.Uuid
  slug       String      @unique
  name       String
  organizers Organizer[]
  createdAt  DateTime    @default(now())

  @@map("plans")
}

// ─── Organizer (empresa/produtor de eventos) ──────────────────────────────────

model Organizer {
  id          String          @id @default(uuid()) @db.Uuid
  name        String
  slug        String          @unique
  planId      String          @db.Uuid
  plan        Plan            @relation(fields: [planId], references: [id])
  trialEndsAt DateTime?
  users       OrganizerUser[]
  createdAt   DateTime        @default(now())

  @@map("organizers")
}

// ─── Usuário de organizer (admin/staff da empresa) ────────────────────────────

model OrganizerUser {
  id           String    @id @default(uuid()) @db.Uuid
  organizerId  String    @db.Uuid
  organizer    Organizer @relation(fields: [organizerId], references: [id])
  name         String
  email        String    @unique
  passwordHash String
  role         String    @default("member")
  lastLoginAt  DateTime?
  createdAt    DateTime  @default(now())

  @@map("organizer_users")
}

// ─── Comprador (usuário final que compra ingressos) ───────────────────────────

model Buyer {
  id           String    @id @default(uuid()) @db.Uuid
  email        String    @unique
  name         String?
  passwordHash String
  lastLoginAt  DateTime?
  createdAt    DateTime  @default(now())

  @@map("buyers")
}

// ─── Refresh tokens ───────────────────────────────────────────────────────────
// Armazenados para permitir revogação explícita (logout, theft detection).
// Nunca armazenar o token em texto plano — apenas SHA-256(token).

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

// ─── Email verification tokens ────────────────────────────────────────────────

model EmailVerification {
  id         String    @id @default(uuid()) @db.Uuid
  userId     String    @db.Uuid
  userType   String    // "organizer_user" | "buyer"
  tokenHash  String    @unique
  expiresAt  DateTime
  verifiedAt DateTime?
  createdAt  DateTime  @default(now())

  @@map("email_verifications")
}
```

### Prisma 7 — `prisma.config.ts`

```typescript
// apps/auth-service/prisma.config.ts
// Prisma 7 separou a URL do schema para suportar múltiplos adapters.

import { defineConfig } from 'prisma/config';

export default defineConfig({
  datasourceUrl: process.env['DATABASE_URL'],
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
});
```

### Gerar o cliente Prisma

```bash
cd apps/auth-service
npx prisma generate
```

> O cliente é gerado em `src/prisma/generated/` — já ignorado pelo `.gitignore`.

---

## Passo 4.2b — PrismaService

```typescript
// apps/auth-service/src/prisma/prisma.service.ts

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from './generated/index.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho fixo, não vem de input do usuário
    const publicKey = readFileSync(join(__dirname, '../../../../keys/public.pem'));

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: publicKey,
      algorithms: ['RS256'],
      audience: 'showpass-api',
      issuer: 'showpass-auth',
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    return payload;
  }
}
```

> **Nota:** Com `module: "NodeNext"` e `package.json` sem `"type": "module"`, os arquivos `.ts` compilam para CommonJS. O `__dirname` está disponível como global — não usar `import.meta.url`.

---

## Passo 4.4 — Token Service

```typescript
// apps/auth-service/src/modules/auth/token.service.ts

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

  async issueTokenPair(
    ctx: AuthContext,
    // exactOptionalPropertyTypes: aceitar undefined explícito de req.headers
    meta: { userAgent?: string | undefined; ipAddress?: string | undefined },
  ): Promise<TokenPair> {
    // ─── 1. Access Token (JWT, curto) ─────────────────────────────────────────
    // exactOptionalPropertyTypes: omitir organizerId quando undefined
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
    const rawRefreshToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

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
      expiresIn: 15 * 60,
    };
  }

  /**
   * Refresh Token Rotation — padrão Google/Meta.
   * Reuso detectado → revogar TODOS os tokens (theft detection).
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

    if (storedToken.revokedAt) {
      this.logger.error(
        `ALERTA: Refresh token reutilizado — possível roubo! userId=${storedToken.tokenableId}`,
      );

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

    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revokedAt: new Date(), lastUsedAt: new Date() },
    });

    const type: 'organizer' | 'buyer' =
      storedToken.tokenableType === 'organizer_user' ? 'organizer' : 'buyer';

    const userCtx: AuthContext = {
      userId: storedToken.tokenableId,
      email: '',  // preenchido via join com OrganizerUser/Buyer em Cap 5
      type,
    };

    return this.issueTokenPair(userCtx, meta);
  }

  async revoke(rawRefreshToken: string): Promise<void> {
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });
  }

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
import bcrypt from 'bcrypt';  // default import com esModuleInterop: true
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenService } from './token.service.js';
import type { TokenPair } from './token.service.js';

const BCRYPT_ROUNDS = 12;  // OWASP A02: ~300ms em hardware moderno

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
    const existing = await this.prisma.organizerUser.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Este e-mail já está em uso');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const freePlan = await this.prisma.plan.findUniqueOrThrow({
      where: { slug: 'free' },
    });

    const user = await this.prisma.$transaction(async (tx) => {
      const organizer = await tx.organizer.create({
        data: {
          name: dto.organizationName,
          slug: this.slugify(dto.organizationName),
          planId: freePlan.id,
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

    this.logger.log(`Novo organizer registrado: userId=${user.id}`);

    return this.tokenService.issueTokenPair(
      { userId: user.id, email: user.email, type: 'organizer', organizerId: user.organizerId },
      {},
    );
  }

  async login(
    email: string,
    password: string,
    meta: { userAgent?: string | undefined; ipAddress?: string | undefined },
  ): Promise<TokenPair> {
    const user = await this.prisma.organizerUser.findUnique({ where: { email } });

    // OWASP A07: timing constante — não revelar se email existe
    const passwordToCompare = user?.passwordHash ?? '$2b$12$invalidhashfortimingreason';
    const isValid = await bcrypt.compare(password, passwordToCompare);

    if (!user || !isValid) {
      this.logger.warn(`Tentativa de login falhou: email=${email}, ip=${meta.ipAddress ?? ''}`);
      throw new UnauthorizedException('E-mail ou senha incorretos');
    }

    await this.prisma.organizerUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.tokenService.issueTokenPair(
      { userId: user.id, email: user.email, type: 'organizer', organizerId: user.organizerId },
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

### BuyerAuthService

```typescript
// apps/auth-service/src/modules/auth/buyer-auth.service.ts

import { Injectable, UnauthorizedException, ConflictException, Logger } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenService } from './token.service.js';
import type { TokenPair } from './token.service.js';

const BCRYPT_ROUNDS = 12;

export interface RegisterBuyerDto {
  email: string;
  password: string;
  name?: string;
}

@Injectable()
export class BuyerAuthService {
  private readonly logger = new Logger(BuyerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async register(dto: RegisterBuyerDto): Promise<TokenPair> {
    const existing = await this.prisma.buyer.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Este e-mail já está em uso');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const buyer = await this.prisma.buyer.create({
      data: { email: dto.email, name: dto.name ?? null, passwordHash },
    });

    return this.tokenService.issueTokenPair({ userId: buyer.id, email: buyer.email, type: 'buyer' }, {});
  }

  async login(
    email: string,
    password: string,
    meta: { userAgent?: string | undefined; ipAddress?: string | undefined },
  ): Promise<TokenPair> {
    const buyer = await this.prisma.buyer.findUnique({ where: { email } });

    const passwordToCompare = buyer?.passwordHash ?? '$2b$12$invalidhashfortimingreason';
    const isValid = await bcrypt.compare(password, passwordToCompare);

    if (!buyer || !isValid) {
      this.logger.warn(`Login de buyer falhou: email=${email}`);
      throw new UnauthorizedException('E-mail ou senha incorretos');
    }

    await this.prisma.buyer.update({ where: { id: buyer.id }, data: { lastLoginAt: new Date() } });
    return this.tokenService.issueTokenPair({ userId: buyer.id, email: buyer.email, type: 'buyer' }, meta);
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
import type { Request } from 'express';

@Injectable()
export class OrganizerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const userId = request.headers['x-user-id'];
    const userType = request.headers['x-user-type'];
    const organizerId = request.headers['x-organizer-id'];

    if (!userId) throw new UnauthorizedException('Não autenticado');
    if (userType !== 'organizer') throw new ForbiddenException('Acesso exclusivo para organizadores');
    if (!organizerId) throw new ForbiddenException('Organizador não associado ao usuário');

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
import type { Request } from 'express';

@Injectable()
export class BuyerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const userId = request.headers['x-user-id'];
    const userType = request.headers['x-user-type'];

    if (!userId) throw new UnauthorizedException('Não autenticado');
    if (userType !== 'buyer') throw new ForbiddenException('Acesso exclusivo para compradores');

    return true;
  }
}
```

---

## Passo 4.7 — Decoradores `@CurrentUser()`

```typescript
// packages/types/src/decorators/current-user.decorator.ts

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request>();

    // exactOptionalPropertyTypes: omitir organizerId se ausente em vez de passar undefined
    const organizerId = request.headers['x-organizer-id'] as string | undefined;
    const user: AuthenticatedUser = {
      id: request.headers['x-user-id'] as string,
      email: request.headers['x-user-email'] as string,
      type: request.headers['x-user-type'] as 'organizer' | 'buyer',
    };

    if (organizerId) {
      user.organizerId = organizerId;
    }

    return user;
  },
);
```

> Exportar em `packages/types/src/index.ts`:
> ```typescript
> export * from './decorators/current-user.decorator.js';
> ```

---

## Passo 4.8 — Auth Controller

```typescript
// apps/auth-service/src/modules/auth/auth.controller.ts

import {
  Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards,
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

// Zod 4: z.email() top-level (não z.string().email() — deprecated)
const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
});

type LoginDto = z.infer<typeof LoginSchema>;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly organizerAuth: OrganizerAuthService,
    private readonly buyerAuth: BuyerAuthService,
    private readonly tokenService: TokenService,
  ) {}

  @Post('login')
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

    this.setRefreshTokenCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
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

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(OrganizerGuard)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @CurrentUser() _user: AuthenticatedUser,
  ): Promise<void> {
    const rawToken = req.cookies['refresh_token'] as string | undefined;
    if (rawToken) await this.tokenService.revoke(rawToken);
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

  @Post('buyer/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 8, ttl: 60_000 } })
  async buyerLogin(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const tokens = await this.buyerAuth.login(body.email, body.password, {
      userAgent: req.headers['user-agent'] ?? undefined,
      ipAddress: req.ip ?? undefined,
    });

    this.setRefreshTokenCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  private setRefreshTokenCookie(res: Response, token: string): void {
    res.cookie('refresh_token', token, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',  // process.env['VAR'] — não process.env.VAR
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/auth',
    });
  }
}
```

---

## Passo 4.9 — Zod Validation Pipe

```typescript
// apps/auth-service/src/common/pipes/zod-validation.pipe.ts

import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';  // ZodSchema foi deprecated no Zod 4 → ZodType

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Zod 4: .issues (renomeado de .errors em v3)
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
```

---

## Passo 4.10 — AuthModule, AppModule e main.ts

```typescript
// apps/auth-service/src/modules/auth/auth.module.ts

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthController } from './auth.controller.js';
import { OrganizerAuthService } from './organizer-auth.service.js';
import { BuyerAuthService } from './buyer-auth.service.js';
import { TokenService } from './token.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { PrismaService } from '../../prisma/prisma.service.js';

// eslint-disable-next-line security/detect-non-literal-fs-filename
const privateKey = readFileSync(join(__dirname, '../../../keys/private.pem'));

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      privateKey,
      signOptions: { algorithm: 'RS256', audience: 'showpass-api', issuer: 'showpass-auth', expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController],
  providers: [PrismaService, TokenService, OrganizerAuthService, BuyerAuthService, JwtStrategy],
  exports: [TokenService, PrismaService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AuthModule {}
```

```typescript
// apps/auth-service/src/app.module.ts

import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './modules/auth/auth.module.js';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100 },
      { name: 'auth',    ttl: 60_000, limit: 5 },
    ]),
    AuthModule,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- padrão NestJS
export class AppModule {}
```

```typescript
// apps/auth-service/src/main.ts

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import cookieParser from 'cookie-parser';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  const port = parseInt(process.env['PORT'] ?? '3006', 10);
  await app.listen(port);
}

void bootstrap();
```

### Dependências adicionais

Adicionar ao `apps/auth-service/package.json`:

```json
"dependencies": {
  "@nestjs/passport": "^11.0.0",
  "cookie-parser": "^1.4.6",
  "passport": "^0.7.0",
  "passport-jwt": "^4.0.0"
},
"devDependencies": {
  "@types/cookie-parser": "^1.4.6",
  "@types/express": "^5.0.0",
  "@types/passport-jwt": "^4.0.0"
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

## Gotchas de versão (stack fixa do projeto)

| Biblioteca | Mudança |
|---|---|
| **Prisma 7** | `url` removido do `datasource` → usar `prisma.config.ts` com `defineConfig` |
| **Prisma 7** | Campos opcionais retornam `string \| null` (não `undefined`) → usar `?? null` ao criar |
| **Zod 4** | `z.string().email()` deprecated → `z.email()` |
| **Zod 4** | `ZodSchema` deprecated → `ZodType` |
| **Zod 4** | `.errors` renomeado → `.issues` em `ZodError` |
| **TypeScript strict** | `exactOptionalPropertyTypes: true` → `meta: { userAgent?: string \| undefined }` |
| **TypeScript strict** | `noPropertyAccessFromIndexSignature` → `process.env['VAR']` (não `process.env.VAR`) |
| **NodeNext CJS** | Sem `"type":"module"` no `package.json` → usar `__dirname` (não `import.meta.url`) |
| **NodeNext** | Imports locais precisam de extensão `.js` → `'./token.service.js'` |

---

## Próximo capítulo

[Capítulo 5 → Event Service](cap-05-event-service.md)
