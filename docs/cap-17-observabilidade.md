# Capítulo 17 — Observabilidade

> **Objetivo:** Instrumentar todos os serviços com OpenTelemetry, criar dashboards Grafana para métricas de negócio, e configurar alertas que acordam o oncall antes que o usuário perceba o problema.

## Os 3 Pilares da Observabilidade

```
Logs   → "O que aconteceu?" (Loki)
Métricas → "Como está agora?" (Prometheus + Grafana)
Traces → "Por que demorou?" (Tempo/Jaeger via OpenTelemetry)
```

---

## Passo 17.1 — OpenTelemetry no NestJS

```typescript
// apps/booking-service/src/instrumentation.ts
//
// Deve ser o PRIMEIRO arquivo carregado — antes do NestJS iniciar.
// Configurar assim no package.json: "dev": "node -r ./src/instrumentation.js ..."
// Ou com tsx: "tsx --require ./src/instrumentation.ts src/main.ts"

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: new Resource({
    [SEMRESATTRS_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'booking-service',
    [SEMRESATTRS_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
  }),

  // Exportar traces para o OpenTelemetry Collector (que repassa para Tempo)
  traceExporter: new OTLPTraceExporter({
    url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
  }),

  // Exportar métricas para o Prometheus via OTEL Collector
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
    }),
    exportIntervalMillis: 15_000,  // exportar a cada 15s
  }),

  // Auto-instrumentação: HTTP, Express, Prisma, ioredis, Kafka — zero código adicional
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        // Não instrumentar health checks (muito volume, pouco valor)
        ignoreIncomingRequestHook: (req) =>
          req.url?.startsWith('/health') ?? false,
      },
    }),
  ],
});

sdk.start();

// Garantir que o SDK seja encerrado corretamente ao parar o processo
process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
```

---

## Passo 17.2 — Métricas de Negócio (custom)

```typescript
// apps/booking-service/src/common/metrics/business-metrics.service.ts
//
// Métricas de negócio — mais valiosas que métricas de infra.
// "Quantas reservas por segundo" é mais acionável que "CPU 60%".

import { Injectable, OnModuleInit } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';

@Injectable()
export class BusinessMetricsService implements OnModuleInit {
  private reservationsCounter!: ReturnType<typeof metrics.getMeter>['createCounter'];
  private reservationConflictsCounter!: ReturnType<typeof metrics.getMeter>['createCounter'];
  private reservationDurationHistogram!: ReturnType<typeof metrics.getMeter>['createHistogram'];
  private activeLockGauge!: ReturnType<typeof metrics.getMeter>['createObservableGauge'];

  onModuleInit(): void {
    const meter = metrics.getMeter('booking-service');

    // Contador: quantas reservas criadas por evento/status
    this.reservationsCounter = meter.createCounter('showpass.reservations.total', {
      description: 'Total de reservas criadas',
      unit: '1',
    });

    // Contador: conflitos de lock (double booking attempts)
    this.reservationConflictsCounter = meter.createCounter('showpass.reservations.conflicts', {
      description: 'Total de tentativas de reservar assento já bloqueado',
    });

    // Histograma: latência de criação de reserva (inclui Redis + DB)
    this.reservationDurationHistogram = meter.createHistogram(
      'showpass.reservations.duration',
      {
        description: 'Tempo de criação de reserva (ms)',
        unit: 'ms',
        advice: {
          explicitBucketBoundaries: [10, 50, 100, 200, 500, 1000, 2000],
        },
      },
    );
  }

  recordReservationCreated(eventId: string): void {
    this.reservationsCounter.add(1, { event_id: eventId, status: 'created' });
  }

  recordReservationConflict(eventId: string, conflictCount: number): void {
    this.reservationConflictsCounter.add(conflictCount, { event_id: eventId });
  }

  recordReservationDuration(durationMs: number, success: boolean): void {
    this.reservationDurationHistogram.record(durationMs, {
      success: String(success),
    });
  }
}
```

---

## Passo 17.3 — Docker Compose: Stack de Observabilidade

```yaml
# Adicionar ao docker-compose.yml

otel-collector:
  image: otel/opentelemetry-collector-contrib:0.120.0
  command: ["--config=/etc/otel-collector-config.yaml"]
  volumes:
    - ./infra/otel/collector-config.yaml:/etc/otel-collector-config.yaml
  ports:
    - "4318:4318"  # OTLP HTTP
  networks:
    - private
    - data

prometheus:
  image: prom/prometheus:v3.1.0
  command:
    - '--config.file=/etc/prometheus/prometheus.yml'
    - '--storage.tsdb.retention.time=30d'
  volumes:
    - ./infra/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
    - prometheus_data:/prometheus
  ports:
    - "9090:9090"
  networks:
    - data

grafana:
  image: grafana/grafana:11.4.0
  environment:
    GF_SECURITY_ADMIN_PASSWORD: admin
    GF_AUTH_ANONYMOUS_ENABLED: "false"
  volumes:
    - grafana_data:/var/lib/grafana
    - ./infra/grafana/dashboards:/var/lib/grafana/dashboards
    - ./infra/grafana/provisioning:/etc/grafana/provisioning
  ports:
    - "3002:3000"  # http://localhost:3002
  networks:
    - data

loki:
  image: grafana/loki:3.3.2
  command: -config.file=/etc/loki/config.yaml
  volumes:
    - ./infra/loki/config.yaml:/etc/loki/config.yaml
    - loki_data:/loki
  ports:
    - "3100:3100"
  networks:
    - data

tempo:
  image: grafana/tempo:2.7.1
  command: ["-config.file=/etc/tempo/config.yaml"]
  volumes:
    - ./infra/tempo/config.yaml:/etc/tempo/config.yaml
    - tempo_data:/tmp/tempo
  ports:
    - "3200:3200"  # query API
    - "4317:4317"  # OTLP gRPC
  networks:
    - data
```

---

## Passo 17.4 — Alertas Grafana

```yaml
# infra/grafana/provisioning/alerting/showpass-alerts.yaml
apiVersion: 1
groups:
  - name: showpass-critical
    interval: 1m
    rules:
      # Alerta: muitos conflitos de reserva (possível ataque ou bug)
      - uid: reservation-conflicts-high
        title: "Alto número de conflitos de reserva"
        condition: C
        data:
          - refId: A
            model:
              expr: |
                rate(showpass_reservations_conflicts_total[5m]) > 100
        noDataState: OK
        annotations:
          summary: "Taxa de conflitos de reserva alta: {{ $values.A }} conflitos/s"
          runbook: "https://wiki.showpass.com.br/runbooks/booking-conflicts"
        labels:
          severity: warning
          team: platform

      # Alerta: alta latência de reserva (P95 > 1s)
      - uid: reservation-latency-high
        title: "Latência de reserva alta (P95 > 1s)"
        condition: C
        data:
          - refId: A
            model:
              expr: |
                histogram_quantile(0.95,
                  rate(showpass_reservations_duration_bucket[5m])
                ) > 1000
        annotations:
          summary: "P95 latência de reserva: {{ $values.A }}ms"
        labels:
          severity: critical
          team: platform
          pagerduty: "true"  # acionar PagerDuty em horário de pico

      # Alerta: booking-service com menos de 2 pods (abaixo do mínimo)
      - uid: booking-pods-low
        title: "Booking Service com poucos pods"
        condition: C
        data:
          - refId: A
            model:
              expr: |
                kube_deployment_status_replicas_available{deployment="booking-service"} < 2
        labels:
          severity: critical
```

---

## Passo 17.5 — Dashboard de Disponibilidade de Assentos

```json
// infra/grafana/dashboards/seat-availability.json (fragmento)
{
  "title": "Seat Availability — Real Time",
  "panels": [
    {
      "title": "Reservas por Segundo",
      "type": "stat",
      "targets": [{
        "expr": "sum(rate(showpass_reservations_total[1m]))"
      }]
    },
    {
      "title": "Taxa de Conflitos (Double Booking Attempts)",
      "type": "timeseries",
      "targets": [{
        "expr": "sum(rate(showpass_reservations_conflicts_total[1m])) by (event_id)"
      }]
    },
    {
      "title": "Latência P95 de Reserva",
      "type": "gauge",
      "targets": [{
        "expr": "histogram_quantile(0.95, rate(showpass_reservations_duration_bucket[5m]))"
      }],
      "thresholds": {
        "steps": [
          { "value": 0, "color": "green" },
          { "value": 500, "color": "yellow" },
          { "value": 1000, "color": "red" }
        ]
      }
    }
  ]
}
```

---

## Testando na prática

A stack de observabilidade (Prometheus, Loki, Tempo, Grafana) sobe via Docker Compose. Você vai ver traces distribuídos, métricas e logs correlacionados em tempo real.

### O que precisa estar rodando

```bash
# Subir toda a infraestrutura incluindo a stack de observabilidade
docker compose --profile observability up -d

# Subir os serviços com OpenTelemetry habilitado
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
pnpm --filter booking-service run dev
```

### Passo a passo

**1. Acessar o Grafana**

Abra: **http://localhost:3000** (Grafana, não o api-gateway)

> Se o api-gateway também usa a porta 3000, o Grafana é configurado em 3100 no `docker-compose.yml`. Verifique a porta no arquivo.

Login padrão: `admin` / `admin`

**2. Verificar o Dashboard de Disponibilidade de Assentos**

No menu lateral → Dashboards → "ShowPass — Disponibilidade de Assentos"

Você deve ver em tempo real:
- Taxa de conflitos de reserva (quantos 409 por minuto)
- Latência de checkout P50/P95/P99
- Locks Redis ativos

**3. Fazer uma reserva e ver o trace**

Execute uma reserva via curl (ou browser), depois no Grafana:

Menu → Explore → Datasource: **Tempo**

Cole o `traceId` do header `x-request-id` da resposta e pressione Enter.

Você verá o trace completo:

```
POST /reservations (API Gateway) — 45ms
  └─ POST /reservations (Booking Service) — 38ms
       ├─ Redis SETNX seat:lock:... — 2ms
       ├─ Redis SETNX seat:lock:... — 1ms
       └─ Prisma INSERT reservations — 12ms
```

**4. Correlacionar trace com logs no Loki**

No trace, clique em qualquer span e selecione "View Logs". O Grafana abre o Loki filtrado pelo `traceId` — você vê todos os logs daquela request específica de todos os serviços.

**5. Consultar métricas no Prometheus**

Menu → Explore → Datasource: **Prometheus**

Query para ver conflitos de reserva:

```promql
rate(showpass_booking_conflicts_total[5m])
```

Query para latência P95:

```promql
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{service="booking-service"}[5m]))
```

**6. Disparar um alerta**

O alerta `BookingConflictRateHigh` dispara quando `> 10 conflitos/min`. Simulate:

```bash
# Disparar 15 tentativas de double booking em 1 minuto
for i in {1..15}; do
  curl -s -X POST http://localhost:3004/reservations \
    -H "Authorization: Bearer $BUYER2_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"eventId\":\"$EVENT_ID\",\"seatIds\":[\"$SEAT_ID\"]}" > /dev/null
done
```

No Grafana → Alerting, o alerta deve mudar para estado `Firing` em ~2 minutos (período de avaliação).

**7. Ver logs estruturados no Loki**

Menu → Explore → Datasource: **Loki**

Query:

```logql
{service="booking-service"} | json | level="error"
```

Você vê apenas os erros, com campos estruturados parseados automaticamente.

---

## Recapitulando

1. **OpenTelemetry** instrumenta automaticamente HTTP, Prisma, Redis, Kafka com zero código de aplicação
2. **Traces distribuídos** — uma request de reserva gera um trace que passa por API Gateway → Booking Service → Redis → PostgreSQL — visível no Tempo
3. **Métricas de negócio** (conflitos de reserva, latência de checkout) são mais acionáveis que métricas de infra
4. **Loki** recebe logs estruturados de todos os serviços; correlacionar por `x-request-id`
5. **Alertas** com severity e runbook — oncall sabe o que fazer quando acorda às 3am

---

## Próximo capítulo

[Capítulo 18 → Padrões Avançados](cap-18-padroes-avancados.md)
