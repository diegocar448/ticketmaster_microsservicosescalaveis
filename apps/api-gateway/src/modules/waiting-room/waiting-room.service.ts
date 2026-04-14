// Fila de espera virtual baseada em Redis Sorted Set.
//
// Redis Sorted Set = estrutura onde cada membro tem um score numérico.
// Usamos timestamp de entrada como score → ordena por chegada (FIFO).
//
// Comandos-chave:
//   ZADD queue:{eventId} {timestamp} {token}  → entrar na fila
//   ZRANK queue:{eventId} {token}              → posição (0 = próximo)
//   ZREMRANGEBYRANK queue:{eventId} 0 99       → avançar 100 usuários

import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@showpass/redis';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

const BATCH_SIZE = 100;        // usuários admitidos por avanço de fila
const ADVANCE_INTERVAL_MS = 5_000;  // avançar fila a cada 5 segundos
const ADMISSION_TOKEN_TTL = 600;    // 10 minutos para completar a compra
const HIGH_DEMAND_THRESHOLD = 1000; // ativar fila quando > 1000 req/s no evento

@Injectable()
export class WaitingRoomService {
  private readonly logger = new Logger(WaitingRoomService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Verifica se um evento está em modo de alta demanda.
   * Usa um contador Redis para medir req/s por evento.
   */
  async isHighDemand(eventId: string): Promise<boolean> {
    const key = `traffic:${eventId}`;
    const count = await this.redis.incrementAvailable(key);

    // Setar TTL de 1s na primeira chamada (janela deslizante de 1 segundo)
    if (count === 1) {
      await this.redis.set(key, count, 1);
    }

    return count > HIGH_DEMAND_THRESHOLD;
  }

  /**
   * Entra na fila de espera para um evento.
   * Gera um token único e aleatório — posição determinada pelo timestamp.
   *
   * Por que aleatório?
   *   Token aleatório (UUID) não pode ser previsto ou manipulado.
   *   A posição na fila é baseada em quando o token foi gerado — não em
   *   quem tem a conexão mais rápida ou qual bot enviou mais requisições.
   *   F5 gera um NOVO token em uma posição PIOR — punição para quem spama.
   */
  async joinQueue(eventId: string): Promise<{
    token: string;
    position: number;
    estimatedWaitSeconds: number;
  }> {
    const token = randomUUID();
    const score = Date.now();

    // ZADD: adiciona o token com score = timestamp atual
    // Sorted Set garante unicidade — não é possível entrar duas vezes
    await this.redis['redis'].zadd(`queue:${eventId}`, score, token);

    const position = await this.getPosition(eventId, token);
    const estimatedWaitSeconds = Math.ceil((position / BATCH_SIZE) * (ADVANCE_INTERVAL_MS / 1000));

    this.logger.log(`Token ${token} entrou na fila de ${eventId} na posição ${position.toString()}`);

    return { token, position, estimatedWaitSeconds };
  }

  /**
   * Retorna a posição atual do token na fila.
   * Posição 0 significa que o usuário pode entrar agora.
   */
  async getPosition(eventId: string, token: string): Promise<number> {
    const rank = await this.redis['redis'].zrank(`queue:${eventId}`, token);
    return rank ?? -1;  // -1 = token inválido ou expirado
  }

  /**
   * Emite um "admission token" JWT quando o usuário chega ao início da fila.
   * Este token é passado nas requisições de booking — sem ele, o Booking Service rejeita.
   */
  async admitUser(eventId: string, token: string): Promise<string | null> {
    const position = await this.getPosition(eventId, token);

    if (position !== 0) return null;  // ainda não é a vez do usuário

    // Remover da fila
    await this.redis['redis'].zrem(`queue:${eventId}`, token);

    // Emitir admission token (JWT de curta duração)
    return this.jwt.sign(
      { eventId, waitingRoomToken: token, admitted: true },
      { expiresIn: ADMISSION_TOKEN_TTL },
    );
  }

  /**
   * Job que avança a fila de 100 em 100 a cada 5 segundos.
   * Chamado por um @Cron no WaitingRoomScheduler.
   * Os primeiros 100 da fila recebem admission token via WebSocket/SSE.
   */
  async advanceQueue(eventId: string): Promise<string[]> {
    // Pegar os primeiros 100 tokens da fila (score mais baixo = chegaram primeiro)
    const admitted = await this.redis['redis'].zrange(`queue:${eventId}`, 0, BATCH_SIZE - 1);

    if (admitted.length === 0) return [];

    // Remover os admitidos da fila
    await this.redis['redis'].zremrangebyrank(`queue:${eventId}`, 0, BATCH_SIZE - 1);

    this.logger.log(`Fila ${eventId}: ${admitted.length.toString()} usuários admitidos`);

    return admitted;  // caller notifica via WebSocket
  }
}