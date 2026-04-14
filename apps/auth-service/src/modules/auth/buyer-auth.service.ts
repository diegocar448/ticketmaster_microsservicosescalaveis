// apps/auth-service/src/modules/auth/buyer-auth.service.ts
//
// Autenticação de compradores (usuários finais).
// Fluxo simplificado: sem organização, sem plano.
//
// Segurança:
//   - Timing constante no login → previne enumeração de usuários (OWASP A07)
//   - bcrypt custo 12 → OWASP A02

import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenService } from './token.service.js';
import type { TokenPair } from './token.service.js';

// OWASP A02: mesmo custo que OrganizerAuthService
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
    const existing = await this.prisma.buyer.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Este e-mail já está em uso');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const buyer = await this.prisma.buyer.create({
      data: {
        email: dto.email,
        // Prisma espera null (não undefined) para campos opcionais nullable
        name: dto.name ?? null,
        passwordHash,
      },
    });

    this.logger.log(`Novo buyer registrado: buyerId=${buyer.id}`);

    return this.tokenService.issueTokenPair(
      {
        userId: buyer.id,
        email: buyer.email,
        type: 'buyer',
      },
      {},
    );
  }

  async login(
    email: string,
    password: string,
    meta: { userAgent?: string | undefined; ipAddress?: string | undefined },
  ): Promise<TokenPair> {
    const buyer = await this.prisma.buyer.findUnique({
      where: { email },
    });

    // OWASP A07: tempo constante para prevenir timing attack
    const passwordToCompare = buyer?.passwordHash ?? '$2b$12$invalidhashfortimingreason';
    const isValid = await bcrypt.compare(password, passwordToCompare);

    if (!buyer || !isValid) {
      this.logger.warn(`Login de buyer falhou: email=${email}, ip=${meta.ipAddress ?? ''}`);
      throw new UnauthorizedException('E-mail ou senha incorretos');
    }

    await this.prisma.buyer.update({
      where: { id: buyer.id },
      data: { lastLoginAt: new Date() },
    });

    return this.tokenService.issueTokenPair(
      {
        userId: buyer.id,
        email: buyer.email,
        type: 'buyer',
      },
      meta,
    );
  }
}
