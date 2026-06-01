// apps/web/src/components/events/ticket-batch-selector.tsx
//
// Lista os lotes (TicketBatch) visíveis com radio buttons. Filtra:
// - isVisible=false (oculto pelo organizador)
// - soldCount === totalQuantity (esgotado)
// - fora da janela de venda (saleStartAt/saleEndAt)
'use client';

import type React from 'react';
import { z } from 'zod';
import { TicketBatchResponseSchema } from '@showpass/types';

type TicketBatch = z.infer<typeof TicketBatchResponseSchema>;

interface Props {
  batches: TicketBatch[];
  selectedBatchId: string | null;
  onSelect: (id: string) => void;
}

const formatBRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function TicketBatchSelector({
  batches,
  selectedBatchId,
  onSelect,
}: Props): React.JSX.Element {
  const now = Date.now();

  const visible = batches
    .filter((b) => b.isVisible)
    .filter((b) => b.soldCount < b.totalQuantity)
    .filter(
      (b) =>
        new Date(b.saleStartAt).getTime() <= now &&
        new Date(b.saleEndAt).getTime() >= now,
    );

  if (visible.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        Nenhum lote disponível para venda no momento.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {visible.map((batch) => {
        const remaining = batch.totalQuantity - batch.soldCount;
        const isSelected = batch.id === selectedBatchId;
        return (
          <button
            key={batch.id}
            type="button"
            onClick={() => {
              onSelect(batch.id);
            }}
            className={
              'w-full flex items-center justify-between p-3 rounded-lg border transition ' +
              (isSelected
                ? 'border-blue-600 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300')
            }
            aria-pressed={isSelected}
          >
            <div className="text-left">
              <p className="font-medium text-sm">{batch.name}</p>
              <p className="text-xs text-gray-500">{remaining} disponíveis</p>
            </div>
            <p className="font-bold text-sm">{formatBRL.format(batch.price)}</p>
          </button>
        );
      })}
    </div>
  );
}
