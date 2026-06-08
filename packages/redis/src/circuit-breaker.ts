// packages/redis/src/circuit-breaker.ts
//
// Circuit Breaker pattern: se o Redis estiver falhando, parar de chamar
// e retornar fallback imediatamente — sem esperar timeout de rede.
//
// Estados do circuito:
//   CLOSED   → operação normal; todas as chamadas passam
//   OPEN     → muitas falhas detectadas; chamadas bloqueadas imediatamente
//   HALF_OPEN → testando recuperação; uma chamada de teste passa
//
// Por que envolver acquireLock e não toda a conexão Redis?
// O CB é criado em volta de FUNÇÕES específicas, não da conexão inteira.
// Assim, uma falha em acquireLock não fecha o circuito de releaseLock
// (que pode estar saudável). Granularidade fina = menor raio de explosão.

import CircuitBreaker from 'opossum';
import { Logger } from '@nestjs/common';

const logger = new Logger('CircuitBreaker');

export interface CircuitBreakerOptions {
  // ms antes de considerar uma chamada como falha (padrão: 3000)
  timeout?: number;
  // % de falhas em `volumeThreshold` chamadas para abrir o circuito (padrão: 50)
  errorThresholdPercentage?: number;
  // ms para tentar fechar o circuito após abrir — half-open (padrão: 30000)
  resetTimeout?: number;
  // quantidade mínima de chamadas antes de avaliar se deve abrir (padrão: 10)
  volumeThreshold?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  name: string,
  options?: CircuitBreakerOptions,
): CircuitBreaker<Parameters<T>, Awaited<ReturnType<T>>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const breaker = new CircuitBreaker<any, any>(fn, {
    timeout: options?.timeout ?? 3000,
    errorThresholdPercentage: options?.errorThresholdPercentage ?? 50,
    resetTimeout: options?.resetTimeout ?? 30_000,
    volumeThreshold: options?.volumeThreshold ?? 10,
  });

  breaker.on('open', () => {
    logger.warn(`[${name}] ABERTO — rejeitando chamadas até recuperação`);
    // Em produção: emitir alerta Slack/PagerDuty via webhook aqui
  });

  breaker.on('halfOpen', () => {
    logger.log(`[${name}] HALF-OPEN — testando recuperação`);
  });

  breaker.on('close', () => {
    logger.log(`[${name}] FECHADO — operação normal restaurada`);
  });

  return breaker as CircuitBreaker<Parameters<T>, Awaited<ReturnType<T>>>;
}
