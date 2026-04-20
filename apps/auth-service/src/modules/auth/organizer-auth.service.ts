// apps/auth-service/src/modules/auth/organizer-auth.service.ts
//
// Autenticação de organizadores (produtores de eventos).
// Registra organizer + empresa em transação atômica.
//
// Segurança:
//   - Timing constante no login → previne enumeração de usuários (OWASP A07)
//   - bcrypt custo 12 → ~300ms por hash (OWASP A02)

import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import bcrypt from 'bcrypt';
import { KafkaProducerService } from '@showpass/kafka';
import { KAFKA_TOPICS } from '@showpass/types';
import type { OrganizerReplicatedEvent } from '@showpass/types';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenService } from './token.service.js';
import type { TokenPair } from './token.service.js';

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
    private readonly kafka: KafkaProducerService,
  ) {}

  async register(dto: RegisterOrganizerDto): Promise<TokenPair> {
    // Verificar se email já existe
    const existing = await this.prisma.organizerUser.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      // OWASP A07: conflito é aceitável no registro — usuário sabe que tentou o mesmo email
      throw new ConflictException('Este e-mail já está em uso');
    }

    // Hash da senha com bcrypt
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Buscar plano gratuito para novos organizadores
    const freePlan = await this.prisma.plan.findUniqueOrThrow({
      where: { slug: 'free' },
    });

    // Criar organizer + user em transação atômica
    const { organizer, user } = await this.prisma.$transaction(async (tx) => {
      const newOrganizer = await tx.organizer.create({
        data: {
          name: dto.organizationName,
          slug: this.slugify(dto.organizationName),
          planId: freePlan.id,
          // Trial de 14 dias no plano Pro
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });

      const newUser = await tx.organizerUser.create({
        data: {
          organizerId: newOrganizer.id,
          name: dto.name,
          email: dto.email,
          passwordHash,
          role: 'owner',
        },
      });

      return { organizer: newOrganizer, user: newUser };
    });

    this.logger.log(`Novo organizer registrado: userId=${user.id}`);

    // Replicação assíncrona para event-service — só campos não-sensíveis.
    // planSlug (não planId) porque os dois bancos têm UUIDs diferentes para
    // o mesmo plano — o consumer resolve slug → planId local antes do upsert.
    // Emitimos FORA da transação: se o Kafka estiver down, o registro não deve
    // falhar. Trade-off: se o emit falhar depois do commit, ficamos com
    // dessincronia temporária. Em prod: usar outbox pattern (tabela local +
    // relay async) — para o tutorial, aceito o risco.
    const event: OrganizerReplicatedEvent = {
      id: organizer.id,
      name: organizer.name,
      slug: organizer.slug,
      planSlug: freePlan.slug,
    };
    try {
      await this.kafka.emit(KAFKA_TOPICS.AUTH_ORGANIZER_CREATED, event, organizer.id);
    } catch (err) {
      // Log mas não relança — registro foi bem-sucedido, replicação é eventually consistent
      this.logger.error(`Falha ao publicar AUTH_ORGANIZER_CREATED: organizerId=${organizer.id}`, err);
    }

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
    meta: { userAgent?: string | undefined; ipAddress?: string | undefined },
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
      this.logger.warn(`Tentativa de login falhou: email=${email}, ip=${meta.ipAddress ?? ''}`);
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
