// apps/booking-service/src/instrumentation.ts
//
// Deve ser carregado ANTES do NestJS — em main.ts é o 1º import (após dotenv,
// para que OTEL_* já estejam no process.env). A auto-instrumentação precisa
// patchear http/express/ioredis/kafka no momento em que esses módulos são
// importados, então o SDK tem que iniciar antes de tudo.

import type { IncomingMessage } from 'node:http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

// O OTEL Collector recebe OTLP/HTTP aqui e repassa: traces→Tempo, métricas→Prometheus.
const endpoint =
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318';

const sdk = new NodeSDK({
  // service.name vem de OTEL_SERVICE_NAME (.env): o envDetector do SDK popula o
  // resource sozinho. A antiga API `new Resource({...})` foi removida na 0.2xx.
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),

  // Métricas exportadas a cada 15s para o Collector (exporter prometheus :8889).
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
    exportIntervalMillis: 15_000,
  }),

  // Logs → Collector → Loki. Registra o LoggerProvider global usado pelo
  // OtelLogger (que substitui o Logger do Nest em main.ts).
  logRecordProcessors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
    ),
  ],

  // Auto-instrumentação: HTTP, Express, Prisma, ioredis, Kafka — zero código extra.
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        // Health checks geram muito volume e pouco valor — não instrumentar.
        ignoreIncomingRequestHook: (req: IncomingMessage) =>
          req.url?.startsWith('/health') ?? false,
      },
      // fs gera spans em excesso (cada leitura de arquivo) — desligar.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

// Encerrar o SDK no SIGTERM garante flush dos últimos traces/métricas antes de sair.
process.on('SIGTERM', () => {
  void sdk.shutdown().finally(() => process.exit(0));
});
