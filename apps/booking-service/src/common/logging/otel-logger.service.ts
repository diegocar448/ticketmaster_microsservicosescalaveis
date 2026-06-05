// apps/booking-service/src/common/logging/otel-logger.service.ts
//
// Ponte Logger do Nest → OpenTelemetry Logs. Estende ConsoleLogger para manter
// o output legível no terminal (dev) e, em paralelo, emite cada linha como log
// record OTLP → Collector → Loki. Assim o painel de Loki no Grafana deixa de
// ficar vazio e os logs ficam correlacionáveis com traces/métricas.

import { ConsoleLogger } from '@nestjs/common';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

// LoggerProvider global é registrado pelo NodeSDK (instrumentation.ts) antes
// deste módulo carregar; api-logs devolve um logger lazy de qualquer forma.
const otelLogger = logs.getLogger('booking-service');

export class OtelLogger extends ConsoleLogger {
  override log(message: unknown, ...rest: unknown[]): void {
    super.log(message, ...rest);
    this.emit(SeverityNumber.INFO, 'INFO', message, rest);
  }

  override error(message: unknown, ...rest: unknown[]): void {
    super.error(message, ...rest);
    this.emit(SeverityNumber.ERROR, 'ERROR', message, rest);
  }

  override warn(message: unknown, ...rest: unknown[]): void {
    super.warn(message, ...rest);
    this.emit(SeverityNumber.WARN, 'WARN', message, rest);
  }

  override debug(message: unknown, ...rest: unknown[]): void {
    super.debug(message, ...rest);
    this.emit(SeverityNumber.DEBUG, 'DEBUG', message, rest);
  }

  override verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(message, ...rest);
    this.emit(SeverityNumber.TRACE, 'TRACE', message, rest);
  }

  private emit(
    severityNumber: SeverityNumber,
    severityText: string,
    message: unknown,
    rest: unknown[],
  ): void {
    // No padrão do Nest, o último argumento costuma ser o `context` (string).
    const last = rest.at(-1);
    const context = typeof last === 'string' ? last : this.context;
    const body =
      typeof message === 'string' ? message : JSON.stringify(message);

    otelLogger.emit({
      severityNumber,
      severityText,
      body,
      attributes: context ? { context } : {},
    });
  }
}
