// apps/booking-service/src/common/metrics/business-metrics.service.ts
//
// Métricas de negócio — mais valiosas que métricas de infra.
// "Quantas reservas por segundo" é mais acionável que "CPU 60%".

import { Injectable, OnModuleInit } from '@nestjs/common';
import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

@Injectable()
export class BusinessMetricsService implements OnModuleInit {
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