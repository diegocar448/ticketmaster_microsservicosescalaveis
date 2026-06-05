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

Primeiro as dependências (`apps/booking-service/package.json`):

```bash
pnpm --filter @showpass/booking-service add \
  @opentelemetry/api \
  @opentelemetry/api-logs \
  @opentelemetry/sdk-node \
  @opentelemetry/sdk-metrics \
  @opentelemetry/sdk-logs \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/exporter-logs-otlp-http \
  @opentelemetry/auto-instrumentations-node
```

> ⚠️ **API atual (SDK 0.2xx):** `new Resource({...})` e os `SEMRESATTRS_*` de
> `@opentelemetry/semantic-conventions` **foram removidos**. Não precisamos deles: o
> `NodeSDK` tem um `envDetector` que lê `OTEL_SERVICE_NAME` do `.env` e popula o
> resource sozinho. Por isso o arquivo abaixo não importa `Resource`.

```typescript
// apps/booking-service/src/instrumentation.ts
//
// Carregado ANTES do NestJS — em main.ts é o 1º import (após dotenv, para que
// OTEL_* já estejam no process.env). A auto-instrumentação patcheia http/redis/
// kafka no momento do import, então o SDK precisa iniciar antes de tudo.

import type { IncomingMessage } from 'node:http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const endpoint =
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318';

const sdk = new NodeSDK({
  // service.name vem de OTEL_SERVICE_NAME (.env) via envDetector.
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),

  // Métricas exportadas a cada 15s para o Collector (exporter prometheus :8889).
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
    exportIntervalMillis: 15_000,
  }),

  // Logs → Collector → Loki. Registra o LoggerProvider global que o OtelLogger usa.
  logRecordProcessors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
    ),
  ],

  // Auto-instrumentação: HTTP, Express, Prisma, ioredis, Kafka — zero código extra.
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        // Health checks: muito volume, pouco valor — não instrumentar.
        ignoreIncomingRequestHook: (req: IncomingMessage) =>
          req.url?.startsWith('/health') ?? false,
      },
      '@opentelemetry/instrumentation-fs': { enabled: false }, // ruído demais
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  void sdk.shutdown().finally(() => process.exit(0));
});
```

**Carregar a instrumentação** — no topo de `apps/booking-service/src/main.ts`, logo
após o dotenv e antes de qualquer import do Nest:

```typescript
import 'dotenv/config';
// DEPOIS do dotenv (precisa de OTEL_* no env), ANTES de @nestjs/core e http.
import './instrumentation.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
// ...
```

> Em ESM a ordem dos `import` é a ordem de avaliação: `dotenv/config` popula o env,
> `./instrumentation.js` sobe o SDK, e só então o Nest é carregado já instrumentado.

### Logs: ponte do Logger do Nest → Loki

A `instrumentation.ts` só registra o *LoggerProvider*. Para os logs da aplicação
chegarem ao Loki, trocamos o logger do Nest por um que também emite via OTLP. Sem
isso o painel de Loki fica vazio — o Loki sobe, mas ninguém envia log.

```typescript
// apps/booking-service/src/common/logging/otel-logger.service.ts
import { ConsoleLogger } from '@nestjs/common';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const otelLogger = logs.getLogger('booking-service');

// Estende ConsoleLogger: mantém o output legível no terminal E emite OTLP→Loki.
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
  // ...debug/verbose idem...

  private emit(
    severityNumber: SeverityNumber,
    severityText: string,
    message: unknown,
    rest: unknown[],
  ): void {
    const last = rest.at(-1);
    const context = typeof last === 'string' ? last : this.context;
    const body = typeof message === 'string' ? message : JSON.stringify(message);
    otelLogger.emit({
      severityNumber,
      severityText,
      body,
      attributes: context ? { context } : {},
    });
  }
}
```

E ativá-lo no `main.ts` (após o `NestFactory.create`):

```typescript
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(new OtelLogger()); // console + OTLP→Loki; bufferLogs pega o bootstrap
```

---

## Passo 17.2 — Métricas de Negócio (custom)

```typescript
// apps/booking-service/src/common/metrics/business-metrics.service.ts
//
// Métricas de negócio — mais valiosas que métricas de infra.
// "Quantas reservas por segundo" é mais acionável que "CPU 60%".

import { Injectable, OnModuleInit } from '@nestjs/common';
import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

@Injectable()
export class BusinessMetricsService implements OnModuleInit {
  // Tipos nomeados do @opentelemetry/api — `Counter`/`Histogram` são o retorno
  // de createCounter/createHistogram (instâncias, não os métodos).
  private reservationsCounter!: Counter;
  private reservationConflictsCounter!: Counter;
  private reservationDurationHistogram!: Histogram;

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

### Registrar como módulo global

```typescript
// apps/booking-service/src/common/metrics/metrics.module.ts
import { Global, Module } from '@nestjs/common';
import { BusinessMetricsService } from './business-metrics.service.js';

@Global() // injetável em qualquer módulo sem reimportar — igual a Redis/Kafka
@Module({
  providers: [BusinessMetricsService],
  exports: [BusinessMetricsService],
})
export class MetricsModule {}
```

E importar no `AppModule` (`imports: [..., MetricsModule, ReservationsModule]`).

### Instrumentar o fluxo de reserva

As métricas só têm valor se forem **chamadas** no caminho crítico. No
`ReservationsService.create()`, injete `BusinessMetricsService` e:

```typescript
async create(buyerId: string, dto: CreateReservationDto) {
  const startedAt = Date.now();
  let success = false;
  try {
    // ...
    if (!lockResult.success) {
      // conflito de lock = tentativa de double booking → alimenta o alerta
      this.metrics.recordReservationConflict(dto.eventId, lockResult.unavailableSeatIds.length);
      throw new ConflictException({ /* ... */ });
    }
    // ... persistir + emitir Kafka ...
    this.metrics.recordReservationCreated(dto.eventId);
    success = true;
    return reservation;
  } finally {
    // registra latência em TODO caminho; label success separa as curvas no Grafana
    this.metrics.recordReservationDuration(Date.now() - startedAt, success);
  }
}
```

> O `finally` garante que sucesso, conflito **e** erro entrem no histograma de
> latência — sem ele, o P95 só mediria o caminho feliz.

---

## Passo 17.3 — Docker Compose: Stack de Observabilidade

Toda a stack fica atrás do profile `observability` — só sobe com `--profile observability`,
mantendo o `docker compose up` do dia a dia leve.

```yaml
# Adicionar ao docker-compose.yml — todos com profiles: ["observability"]

otel-collector:
  profiles: ["observability"]
  image: otel/opentelemetry-collector-contrib:0.120.0
  command: ["--config=/etc/otel-collector-config.yaml"]
  volumes:
    - ./infra/otel/collector-config.yaml:/etc/otel-collector-config.yaml
  ports:
    - "4318:4318"  # OTLP HTTP
  networks:
    - private        # recebe OTLP dos serviços em container
    - observability  # exporta p/ tempo, expõe :8889 ao prometheus, publica 4318 ao host

prometheus:
  profiles: ["observability"]
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
    - observability

grafana:
  profiles: ["observability"]
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
    - observability

loki:
  profiles: ["observability"]
  image: grafana/loki:3.3.2
  command: -config.file=/etc/loki/config.yaml
  volumes:
    - ./infra/loki/config.yaml:/etc/loki/config.yaml
    - loki_data:/loki
  ports:
    - "3100:3100"
  networks:
    - observability

tempo:
  profiles: ["observability"]
  image: grafana/tempo:2.7.1
  command: ["-config.file=/etc/tempo/config.yaml"]
  volumes:
    - ./infra/tempo/config.yaml:/etc/tempo/config.yaml
    # /var/tempo já existe na imagem com dono uid 10001; um named volume herda essa
    # permissão. Montar em /tmp/tempo daria "mkdir: permission denied" (volume root).
    - tempo_data:/var/tempo
  ports:
    - "3200:3200"  # query API
    - "4317:4317"  # OTLP gRPC
  networks:
    - observability
```

> ⚠️ **Rede `observability` NÃO pode ser `internal: true`.** Em rede só-interna o Docker
> aceita o `ports:` mas nunca ativa o bind — `localhost:3002` responde `Connection refused`.
> Por isso esses serviços ficam numa rede com saída externa (diferente de `data`, que é interna):

```yaml
# networks: (topo do docker-compose.yml)
networks:
  # ... public, private, data (internal: true) ...
  observability:
    # SEM internal: o dev acessa Grafana/Prometheus/etc. pelo host.

# volumes:
volumes:
  # ... postgres_data, etc. ...
  prometheus_data:
  grafana_data:
  loki_data:
  tempo_data:
```

### Arquivos de configuração

Cada serviço lê um arquivo de config montado por bind. **Crie-os antes de subir** — se o
caminho não existir, o Docker cria um *diretório* vazio no lugar e o mount falha com
`not a directory`.

```yaml
# infra/otel/collector-config.yaml — recebe OTLP e distribui:
#   traces→Tempo · métricas→Prometheus · logs→Loki
receivers:
  otlp:
    protocols:
      http: { endpoint: 0.0.0.0:4318 }   # serviços enviam OTLP/HTTP aqui
      grpc: { endpoint: 0.0.0.0:4319 }   # 4317 é do Tempo no host
processors:
  batch: {}
exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls: { insecure: true }
  prometheus:
    endpoint: 0.0.0.0:8889             # Prometheus raspa aqui (job otel-collector)
  otlphttp/loki:                       # Loki 3.x: endpoint OTLP nativo (/otlp/v1/logs)
    endpoint: http://loki:3100/otlp
    tls: { insecure: true }
  debug: { verbosity: basic }
service:
  pipelines:
    traces:  { receivers: [otlp], processors: [batch], exporters: [otlp/tempo, debug] }
    metrics: { receivers: [otlp], processors: [batch], exporters: [prometheus] }
    logs:    { receivers: [otlp], processors: [batch], exporters: [otlphttp/loki, debug] }
```

```yaml
# infra/prometheus/prometheus.yml
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: prometheus
    static_configs: [{ targets: ["localhost:9090"] }]
  - job_name: otel-collector            # métricas agregadas pelo collector (:8889)
    static_configs: [{ targets: ["otel-collector:8889"] }]
```

```yaml
# infra/loki/config.yaml — single-binary (dev), filesystem, sem auth
auth_enabled: false
server: { http_listen_port: 3100 }
common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem: { chunks_directory: /loki/chunks, rules_directory: /loki/rules }
  replication_factor: 1
  ring: { kvstore: { store: inmemory } }
schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index: { prefix: index_, period: 24h }
limits_config:
  allow_structured_metadata: true   # ingestão OTLP usa structured metadata p/ atributos
```

```yaml
# infra/tempo/config.yaml — recebe traces via OTLP gRPC, armazena em /var/tempo
server: { http_listen_port: 3200 }
distributor:
  receivers:
    otlp:
      protocols:
        grpc: { endpoint: 0.0.0.0:4317 }  # otel-collector envia traces aqui
storage:
  trace:
    backend: local
    local: { path: /var/tempo/blocks }
    wal:   { path: /var/tempo/wal }
```

### Datasources e dashboards provisionados

O Grafana provisiona datasources, dashboards e alertas no boot. Os `uid` dos datasources
são fixos para que dashboards e alertas os referenciem de forma estável.

```yaml
# infra/grafana/provisioning/datasources/datasources.yaml
apiVersion: 1
datasources:
  - { name: Prometheus, uid: prometheus, type: prometheus, access: proxy, url: http://prometheus:9090, isDefault: true }
  - { name: Loki,       uid: loki,       type: loki,       access: proxy, url: http://loki:3100 }
  - { name: Tempo,      uid: tempo,      type: tempo,      access: proxy, url: http://tempo:3200 }
```

```yaml
# infra/grafana/provisioning/dashboards/dashboards.yaml — varre /var/lib/grafana/dashboards
apiVersion: 1
providers:
  - name: showpass
    folder: ShowPass
    type: file
    options: { path: /var/lib/grafana/dashboards }
```

---

## Passo 17.4 — Alertas Grafana

O unified alerting do Grafana é estrito: cada **grupo** precisa de `folder`, e cada **regra**
de uma query (datasource real) + um stage de *threshold* no datasource de expressão `__expr__`.
Por isso a comparação (`> 100`, `> 1000`, `< 2`) **não** fica embutida no PromQL — vira um
`evaluator` no stage `C`, que é o `condition` final. Embutir no PromQL faz o provisioning falhar.

```yaml
# infra/grafana/provisioning/alerting/showpass-alerts.yaml
apiVersion: 1
groups:
  - orgId: 1
    name: showpass-critical
    folder: ShowPass          # obrigatório — pasta onde as regras vivem
    interval: 1m
    rules:
      # Alerta: muitos conflitos de reserva (possível ataque ou bug)
      - uid: reservation-conflicts-high
        title: "Alto número de conflitos de reserva"
        condition: C
        for: 5m
        noDataState: OK
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              instant: true
              expr: rate(showpass_reservations_conflicts_total[5m])
          - refId: C            # threshold: A > 100
            datasourceUid: __expr__
            model:
              refId: C
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [100] }
        annotations:
          summary: "Taxa de conflitos de reserva alta: {{ $values.A }} conflitos/s"
          runbook: "https://wiki.showpass.com.br/runbooks/booking-conflicts"
        labels: { severity: warning, team: platform }

      # Alerta: alta latência de reserva (P95 > 1s)
      - uid: reservation-latency-high
        title: "Latência de reserva alta (P95 > 1s)"
        condition: C
        for: 5m
        noDataState: OK
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              instant: true
              expr: histogram_quantile(0.95, rate(showpass_reservations_duration_milliseconds_bucket[5m]))
          - refId: C            # threshold: A > 1000ms
            datasourceUid: __expr__
            model:
              refId: C
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [1000] }
        annotations:
          summary: "P95 latência de reserva: {{ $values.A }}ms"
        labels: { severity: critical, team: platform, pagerduty: "true" }

      # Alerta: booking-service com menos de 2 pods (abaixo do mínimo)
      - uid: booking-pods-low
        title: "Booking Service com poucos pods"
        condition: C
        for: 2m
        noDataState: NoData
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              instant: true
              expr: kube_deployment_status_replicas_available{deployment="booking-service"}
          - refId: C            # threshold: A < 2
            datasourceUid: __expr__
            model:
              refId: C
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: lt, params: [2] }
        labels: { severity: critical, team: platform }
```

---

## Passo 17.5 — Dashboard de Disponibilidade de Assentos

> 🐛 **Gotcha do nome da métrica (unidade no nome):** o histograma é criado com
> `unit: 'ms'`. O exporter Prometheus do Collector **acrescenta a unidade ao nome** →
> a série vira `showpass_reservations_duration_milliseconds_bucket` (não
> `..._duration_bucket`). Os counters (`...reservations_total`, `...conflicts_total`)
> não têm unidade e ficam sem sufixo. Por isso o PromQL do P95 usa o nome **com**
> `_milliseconds`. Se o painel ficar vazio, confira o nome real em
> Prometheus → *Status → Targets*/autocomplete.

O JSON precisa ser **puro** (sem comentários `//`) e cada painel precisa de `gridPos`,
`datasource` e `refId` no target — senão o provider de dashboards loga
`invalid character '/'` ou ignora os painéis. Fragmento (o arquivo completo está no repo):

```json
{
  "uid": "seat-availability",
  "title": "Seat Availability — Real Time",
  "schemaVersion": 39,
  "refresh": "10s",
  "panels": [
    {
      "id": 1,
      "title": "Reservas por Segundo",
      "type": "stat",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 8, "x": 0, "y": 0 },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "expr": "sum(rate(showpass_reservations_total[1m]))"
        }
      ]
    },
    {
      "id": 3,
      "title": "Latência P95 de Reserva",
      "type": "gauge",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 8, "x": 0, "y": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "ms",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "value": null, "color": "green" },
              { "value": 500, "color": "yellow" },
              { "value": 1000, "color": "red" }
            ]
          }
        }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "expr": "histogram_quantile(0.95, rate(showpass_reservations_duration_milliseconds_bucket[5m]))"
        }
      ]
    }
  ]
}
```

---

## Como funciona a observabilidade (fluxo end-to-end)

Para entender como Prometheus, Loki e Tempo trabalham juntos, vamos rastrear uma requisição real: **criar uma reserva** (`POST /reservations`).

### 🔄 Fluxo da Requisição

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. CLIENTE FAZ REQUEST HTTP                                         │
│    curl -X POST http://localhost:3001/checkout/confirm \            │
│      -H "Authorization: Bearer $token" \                            │
│      -d '{"eventId":"...", "items":[...]}'                          │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. API GATEWAY (3000) — Porta de Entrada                            │
│    • Middleware JwtAuthMiddleware valida Bearer token              │
│    • Injeta headers internos: x-user-id, x-user-type, x-organizer-id
│    • OpenTelemetry inicia um SPAN raiz (@telemetry/nest.ts)       │
│      trace_id = random UUID (ex: a1b2c3d4e5f6g7h8)                │
│      span_id = correlaciona com toda a request                    │
│    • Proxia para booking-service:3004/reservations                │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. BOOKING-SERVICE (3004) — Processamento da Reserva               │
│                                                                     │
│    POST /reservations — ReservationController.create()             │
│    • Child SPAN: "create_reservation"                              │
│    • Atributos: userId, eventId, quantity, timestamp               │
│                                                                     │
│    ① Valida entrada (Zod schema)                                   │
│      → Métrica: showpass_reservations_total (label: status=valid)  │
│                                                                     │
│    ② SeatLockService.acquireLocks() — Redis SETNX (atômico)       │
│      → Child SPAN: "acquire_locks"                                 │
│      → Atributos: seats_requested, lock_ttl                        │
│      → Métrica: showpass_locks_acquired (gauge)                    │
│                                                                     │
│    ③ BookingService.createReservation()                           │
│      → Calcula preço, gera ID                                      │
│      → Child SPAN: "calculate_price"                               │
│      → Métrica: showpass_reservations_duration_milliseconds        │
│        (histograma: P50, P95, P99)                                 │
│                                                                     │
│    ④ DATABASE (PostgreSQL) — INSERT na tabela Reservation         │
│      → Child SPAN: "db.statement"                                  │
│      → Query: INSERT INTO reservations (id, userId, eventId, ...) │
│      → Atributos: rows_affected, db.system=postgresql             │
│      → Métrica: showpass_db_queries_duration_ms                    │
│                                                                     │
│    Sucesso ✅ ou erro ❌ ?                                         │
│      if erro (duplicate seat, low stock):                          │
│        → Métrica: showpass_reservations_conflicts_total++          │
│        → Log ERROR: "Conflito de assento" (traceId=...)            │
│                                                                     │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. PUBLICAR EVENTO NO KAFKA (Broker na porta 9092)                 │
│                                                                     │
│    Se sucesso → emit ReservationCreatedEvent:                      │
│    {                                                               │
│      reservationId: "uuid",                                        │
│      eventId: "uuid",                                              │
│      traceId: "a1b2c3d4e5f6g7h8",  ← CORRELAÇÃO CRÍTICA           │
│      timestamp: "2026-06-04T..."                                   │
│    }                                                               │
│                                                                     │
│    Topic: showpass.reservations.created                            │
│    Partição: hash(eventId) % 3  (load balancing)                   │
│    • Child SPAN: "kafka.send"                                      │
│    • Atributos: topic, partition, offset                           │
│    • Métrica: showpass_kafka_messages_sent_total                   │
│                                                                     │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. RESPOSTA HTTP RETORNA AO CLIENTE                                │
│                                                                     │
│    Status: 201 Created                                             │
│    Body: { reservationId, total, status: "confirmed" }             │
│    Header: X-Trace-ID: "a1b2c3d4e5f6g7h8" (para debug)             │
│                                                                     │
│    Time elapsed: 245ms (capturado em showpass_reservations_duration│
│                                                                     │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     ▼ (async — não bloqueia o client)
┌─────────────────────────────────────────────────────────────────────┐
│ 6. WORKER-SERVICE (3007) — Consome o Evento                        │
│                                                                     │
│    Kafka Consumer escuta showpass.reservations.created              │
│    • Child SPAN: "kafka.receive"                                   │
│    • Herda o TRACE ID do evento (mesma trace: a1b2c3d4e5f6g7h8)   │
│    • Child SPAN: "send_confirmation_email"                         │
│    • Atributos: recipient, email_template                          │
│    • Métrica: showpass_emails_sent_total                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 📊 Os 3 Pilares: Onde vão os dados

Tudo que aconteceu acima gera **3 tipos de dados**:

#### 1️⃣ **Métricas (Prometheus — séries temporais)**

```promql
# Histograma de latência: quantas requisições em cada bucket
showpass_reservations_duration_milliseconds_bucket{
  le="50",
  eventId="event-uuid",
  status="success"
} 3421   ← 3421 requisições responderam em <50ms

showpass_reservations_duration_milliseconds_bucket{
  le="200",
  eventId="event-uuid",
  status="success"
} 8523   ← 8523 requisições responderam em <200ms

# Contador: quantas reservas foram criadas
showpass_reservations_total{
  eventId="event-uuid",
  status="success"
} 10452

# Conflitos detectados (double-booking)
showpass_reservations_conflicts_total{
  eventId="event-uuid",
  reason="seat_unavailable"
} 127
```

**Acesso:** `http://localhost:9090` (Prometheus UI)

**Exemplo de query — P95 de latência do último 1h:**
```promql
histogram_quantile(0.95, rate(showpass_reservations_duration_milliseconds_bucket[1h]))
# Resultado: 185ms
```

#### 2️⃣ **Logs (Loki — texto estruturado + busca por trace)**

Cada evento gera logs em JSON:

```json
{
  "timestamp": "2026-06-04T15:30:45.123Z",
  "level": "INFO",
  "service_name": "booking-service",
  "trace_id": "a1b2c3d4e5f6g7h8",
  "span_id": "x1y2z3a4",
  "message": "Reservation created successfully",
  "userId": "user-uuid",
  "eventId": "event-uuid",
  "reservationId": "reservation-uuid",
  "duration_ms": 245
}

{
  "timestamp": "2026-06-04T15:30:46.001Z",
  "level": "ERROR",
  "service_name": "booking-service",
  "trace_id": "a1b2c3d4e5f6g7h8",
  "span_id": "y9z8a7b6",
  "message": "Seat lock conflict detected",
  "seatIds": ["seat-123", "seat-124"],
  "reason": "SETNX returned 0"
}
```

**Acesso:** `http://localhost:3100` (Loki UI)

**Exemplo de query — todos os erros dessa requisição:**
```logql
{trace_id="a1b2c3d4e5f6g7h8"} | json | level="ERROR"
```

#### 3️⃣ **Traces Distribuídos (Tempo — árvore de spans)**

Uma **única requisição** gera uma árvore de spans conectados:

```
Trace ID: a1b2c3d4e5f6g7h8 (total: 245ms)
├─ Span: "POST /reservations" (245ms)
│  ├─ Span: "JwtAuthMiddleware" (2ms)
│  ├─ Span: "acquire_locks" (15ms)
│  │  ├─ Span: "redis.call SETNX" (3ms)
│  │  └─ Span: "redis.call SETNX" (2ms)
│  ├─ Span: "calculate_price" (5ms)
│  ├─ Span: "db.insert" (45ms)
│  │  └─ Span: "pg.query INSERT INTO reservations" (40ms)
│  ├─ Span: "kafka.send" (8ms)
│  │  └─ Span: "broker.acknowledge" (5ms)
│  └─ Span: "response.serialize" (3ms)
│
└─ Span: "kafka.receive" (142ms depois)
   └─ Span: "send_confirmation_email" (850ms, async)
```

**Acesso:** `http://localhost:3200` (Tempo UI) ou `http://localhost:3002` (Grafana Explorer)

Você clica num span e vê:
- ⏱️ Duração exata de cada operação
- 📝 Atributos (userId, eventId, status)
- 📋 Logs que aconteceram naquele span
- ❌ Erros/exceções

### 🔗 A Chave Mágica: traceId

O **`traceId`** une TUDO (métrica + log + trace):

```javascript
// Request HTTP inicia
GET /checkout → middleware JwtAuthMiddleware
  ↓
  // cria traceId = "a1b2c3d4e5f6g7h8"

// Passa pelo OpenTelemetry
POST /reservations (booking-service)
  Header: traceparent: "00-a1b2c3d4e5f6g7h8-..."
  ↓
  // Booking-service lê o header
  // Todos os logs têm trace_id="a1b2c3d4e5f6g7h8"
  // Todos os spans têm trace_id="a1b2c3d4e5f6g7h8"
  // Todas as métricas são etiquetadas com trace_id (opcional, mas útil)

// Publica no Kafka
Topic: showpass.reservations.created
  Message: {
    traceId: "a1b2c3d4e5f6g7h8",  ← continua o mesmo!
    ...
  }

// Worker-service consome
  Logs de worker: trace_id="a1b2c3d4e5f6g7h8"
  Métricas de email: trace_id="a1b2c3d4e5f6g7h8"
```

### 🎯 Caso de Uso: Debug de Problema

**Situação:** "Reservas são criadas, mas emails não chegam"

```bash
# 1. Encontrar a anomalia nas métricas
Prometheus:
  showpass_reservations_total{status="success"} = 1000  ✅
  showpass_emails_sent_total = 876                      ❌ caiu!

# 2. Buscar logs de erro
Loki query:
  {service_name="worker-service"} | json | level="ERROR"

Encontrou:
  {
    trace_id: "a1b2c3d4e5f6g7h8",
    message: "SMTP connection timeout",
    timestamp: "2026-06-04T15:30:47.001Z"
  }

# 3. Abrir o trace completo no Tempo
Tempo: Buscar trace a1b2c3d4e5f6g7h8

Vê a árvore:
  ├─ Reservation criada ✅ (201ms)
  ├─ Kafka event publicado ✅ (8ms)
  └─ Email envio ❌ (timeout após 30s)
     └─ Log: "SMTP timeout"

# 4. Correlação
A métrica, log e trace apontam pro mesmo problema
→ Servidor SMTP está lento

# 5. Alerta automático
Grafana Rule:
  IF rate(showpass_emails_sent_total) DROP > 10%
  THEN send alert to #ops-showpass Slack
```

### 📈 Dashboard Grafana

O dashboard **"Seat Availability — Real Time"** (`http://localhost:3002`) mostra:

```
┌─────────────────────────────────────┐
│ Reservas/s (últimos 5 min)          │  45.3 req/s      ↗
├─────────────────────────────────────┤
│ Latência P95                        │  185ms           ↗
├─────────────────────────────────────┤
│ Conflitos (últimos 5 min)           │  3 conflitos     →
├─────────────────────────────────────┤
│ Gráfico: Latência em tempo real     │
│                                 ╱   │
│                             ╱       │
│                         ╱           │
│                     ╱               │
│                 ╱                   │
└─────────────────────────────────────┘
```

Clique num ponto do gráfico → abre o **Tempo** com os traces daquele exato momento.

---

## Testando na prática

> **Guia completo:** ver [docs/guia-de-testes.md — Fluxo 9](guia-de-testes.md#12-fluxo-9--observabilidade-métricas--traces--logs).
> Inclui o simulador de carga (`scripts/observe-sim.mjs`) e os comandos curl para
> validar as séries no Prometheus, traces no Tempo e logs no Loki.

A stack de observabilidade (Prometheus, Loki, Tempo, Grafana) sobe via Docker Compose. Você vai ver traces distribuídos, métricas e logs correlacionados em tempo real.

### O que precisa estar rodando

```bash
# Subir toda a infraestrutura incluindo a stack de observabilidade
docker compose --profile observability up -d

# Subir os serviços com OpenTelemetry habilitado
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
pnpm --filter @showpass/booking-service run dev
```

### Passo a passo

**1. Acessar o Grafana**

Abra: **http://localhost:3002** (mapeado de `3002:3000` no compose, para não colidir com
o api-gateway na 3000 nem o web na 3001).

Login padrão: `admin` / `admin`

**2. Verificar o Dashboard de Disponibilidade de Assentos**

No menu lateral → Dashboards → pasta **ShowPass** → "Seat Availability — Real Time"

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
POST /bookings/reservations (API Gateway) — 45ms
  └─ POST /bookings/reservations (Booking Service) — 38ms
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
# Disparar 15 tentativas de double booking em 1 minuto.
# Usar o DTO atual: items[] com ticketBatchId + seatId (ver cap-06).
for i in {1..15}; do
  curl -s -X POST http://localhost:3004/bookings/reservations \
    -H "Authorization: Bearer $BUYER2_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"eventId\":\"$EVENT_ID\",
      \"items\":[{\"ticketBatchId\":\"$BATCH_PISTA_ID\",\"seatId\":\"$SEAT_ID\",\"quantity\":1}]
    }" > /dev/null
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
