// apps/booking-service/scripts/observe-sim.mjs
//
// Simulador de observabilidade — gera carga sintética nos 3 pilares para você
// ver Grafana/Prometheus/Tempo/Loki se encherem AO VIVO, sem precisar subir
// postgres/redis/kafka/event-service nem semear banco.
//
// Cada "reserva" simulada:
//   - abre um SPAN (trace → Tempo)
//   - decide sucesso (70%) ou conflito de lock (30%)
//   - incrementa os COUNTERS e grava a DURATION (métricas → Prometheus)
//   - emite um LOG dentro do span, então o log carrega traceId (logs → Loki)
//
// Rodar (de dentro de apps/booking-service, para resolver as deps OTel):
//   node scripts/observe-sim.mjs
// Parar: Ctrl+C
//
// Variáveis opcionais:
//   OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318)
//   SIM_INTERVAL_MS (default 800)  · SIM_BATCH (reservas por tick, default 8)

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { metrics, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

process.env.OTEL_SERVICE_NAME ??= 'booking-service';
const endpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
const intervalMs = Number(process.env.SIM_INTERVAL_MS ?? 800);
const batch = Number(process.env.SIM_BATCH ?? 8);

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
    exportIntervalMillis: 5000,
  }),
  logRecordProcessors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
    ),
  ],
});
sdk.start();

const meter = metrics.getMeter('booking-service');
const created = meter.createCounter('showpass.reservations.total');
const conflicts = meter.createCounter('showpass.reservations.conflicts');
const duration = meter.createHistogram('showpass.reservations.duration', {
  advice: { explicitBucketBoundaries: [10, 50, 100, 200, 500, 1000, 2000] },
});
const tracer = trace.getTracer('observe-sim');
const otelLog = logs.getLogger('booking-service');

const events = ['evt-bruno-mars', 'evt-taylor-swift', 'evt-coldplay'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
let n = 0;

function simulateReservation() {
  const eventId = pick(events);
  // startActiveSpan deixa o span "ativo": o log emitido dentro herda o traceId.
  tracer.startActiveSpan('POST /reservations', (span) => {
    span.setAttribute('event_id', eventId);
    const isConflict = Math.random() < 0.3;
    const latency = isConflict
      ? 5 + Math.random() * 40 // conflito falha rápido
      : 60 + Math.random() * 900; // sucesso passa por Redis + DB

    if (isConflict) {
      conflicts.add(1, { event_id: eventId });
      duration.record(latency, { success: 'false' });
      span.setStatus({ code: 2, message: 'seat unavailable' }); // ERROR
      otelLog.emit({
        severityNumber: SeverityNumber.WARN,
        severityText: 'WARN',
        body: `Conflito de lock no evento ${eventId} (double booking)`,
        attributes: { context: 'ReservationsService', event_id: eventId },
      });
    } else {
      created.add(1, { event_id: eventId, status: 'created' });
      duration.record(latency, { success: 'true' });
      otelLog.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: `Reserva criada no evento ${eventId}`,
        attributes: { context: 'ReservationsService', event_id: eventId },
      });
    }
    span.end();
    n++;
  });
}

console.log(
  `Simulando observabilidade → ${endpoint}  (${batch} reservas a cada ${intervalMs}ms). Ctrl+C para parar.`,
);
const timer = setInterval(() => {
  for (let i = 0; i < batch; i++) simulateReservation();
  process.stdout.write(`\r  reservas simuladas: ${n}   `);
}, intervalMs);

process.on('SIGINT', () => {
  clearInterval(timer);
  console.log('\nencerrando — flush dos últimos sinais...');
  sdk.shutdown().finally(() => process.exit(0));
});
