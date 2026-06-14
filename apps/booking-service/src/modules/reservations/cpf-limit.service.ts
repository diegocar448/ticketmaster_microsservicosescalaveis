// apps/booking-service/src/modules/reservations/cpf-limit.service.ts
//
// Limite de ingressos por CPF (cap-19) — a defesa anti-cambista.
//
// O problema que resolve: validar "esse CPF já comprou o máximo?" com um
// SELECT count(*) seguido de INSERT é uma race condition clássica. Sob 500
// reservas concorrentes do mesmo CPF, todas leem o mesmo count e todas passam.
// A solução é a MESMA filosofia do SETNX dos assentos: um contador atômico no
// Redis (Lua check-and-increment), com rollback (compensação) se a reserva
// falhar depois — exatamente como os locks são liberados na Saga (cap-18).

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisService } from '@showpass/redis';

// Em produção, viria da config do lote/evento (TicketBatch.maxPerCpf). Aqui
// usamos env para não exigir migration — suficiente para o load test do limite.
const MAX_TICKETS_PER_CPF = Number(process.env['MAX_TICKETS_PER_CPF'] ?? '4');

// Janela do contador = duração típica da venda. O contador expira sozinho
// (sem cron de limpeza), igual ao TTL dos locks.
const CPF_WINDOW_SECONDS = Number(process.env['CPF_LIMIT_WINDOW_SECONDS'] ?? '86400');

@Injectable()
export class CpfLimitService {
  private readonly logger = new Logger(CpfLimitService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Consome `quantity` do orçamento de ingressos do CPF para o evento.
   *
   * @returns uma função de COMPENSAÇÃO (rollback) que devolve a cota — deve ser
   *          chamada se a reserva falhar nas etapas seguintes (lock/DB).
   * @throws ConflictException (409) se ultrapassaria o limite — sem incrementar.
   */
  async consume(eventId: string, cpf: string, quantity: number): Promise<() => Promise<void>> {
    const key = `cpf:limit:${eventId}:${this.hashCpf(cpf)}`;

    const total = await this.redis.tryConsumeWithLimit(
      key,
      quantity,
      MAX_TICKETS_PER_CPF,
      CPF_WINDOW_SECONDS,
    );

    if (total === -1) {
      // 409 = mesma semântica do assento indisponível: limite de negócio atingido.
      throw new ConflictException({
        message: `Limite de ${String(MAX_TICKETS_PER_CPF)} ingressos por CPF atingido para este evento`,
      });
    }

    // rollback: devolve a cota (DECRBY) se uma etapa posterior falhar
    return async () => {
      await this.redis.decrementAvailable(key, quantity);
      this.logger.warn('Cota de CPF devolvida após falha posterior', { eventId });
    };
  }

  /**
   * Hash com pepper de ambiente. O mesmo CPF gera sempre a mesma chave, mas o
   * valor no Redis NÃO é reversível — não armazenamos o número cru (LGPD Art. 5).
   * O pepper fica em variável de ambiente, fora do banco/Redis.
   */
  private hashCpf(cpf: string): string {
    const pepper = process.env['CPF_PEPPER'] ?? 'dev_pepper_nao_usar_em_producao';
    return createHash('sha256').update(cpf + pepper).digest('hex');
  }
}
