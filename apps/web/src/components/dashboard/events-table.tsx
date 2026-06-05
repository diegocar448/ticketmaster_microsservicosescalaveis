'use client';

// apps/web/src/components/dashboard/events-table.tsx
//
// Data-table dos eventos (estilo do template next-shadcn-admin-dashboard, MIT):
// TanStack Table (headless) + componentes Table do shadcn. Ordenação por coluna,
// alinhamento numérico à direita e empty state. Client Component (TanStack usa hooks).

import type React from 'react';
import { useState } from 'react';
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { ArrowUpDown } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface EventRow {
  id: string;
  title: string;
  sold: number;
  available: number;
  revenue: number;
}

const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

// Cabeçalho clicável que alterna a ordenação da coluna.
function SortHeader({
  label,
  onClick,
  align = 'left',
}: {
  label: string;
  onClick: () => void;
  align?: 'left' | 'right';
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-1 text-sm font-medium ${
        align === 'right' ? 'justify-end' : ''
      }`}
    >
      {label}
      <ArrowUpDown className="size-3.5 opacity-60" />
    </button>
  );
}

const columns: ColumnDef<EventRow>[] = [
  {
    accessorKey: 'title',
    header: ({ column }) => (
      <SortHeader
        label="Evento"
        onClick={() => {
          column.toggleSorting(column.getIsSorted() === 'asc');
        }}
      />
    ),
    cell: ({ row }) => (
      <span className="font-medium">{row.getValue('title')}</span>
    ),
  },
  {
    accessorKey: 'sold',
    header: ({ column }) => (
      <SortHeader
        label="Vendidos"
        align="right"
        onClick={() => {
          column.toggleSorting(column.getIsSorted() === 'asc');
        }}
      />
    ),
    cell: ({ row }) => (
      <div className="text-right">{row.getValue<number>('sold')}</div>
    ),
  },
  {
    accessorKey: 'available',
    header: () => <div className="text-right">Disponíveis</div>,
    cell: ({ row }) => (
      <div className="text-right text-muted-foreground">
        {row.getValue<number>('available')}
      </div>
    ),
  },
  {
    accessorKey: 'revenue',
    header: ({ column }) => (
      <SortHeader
        label="Receita"
        align="right"
        onClick={() => {
          column.toggleSorting(column.getIsSorted() === 'asc');
        }}
      />
    ),
    cell: ({ row }) => (
      <div className="text-right font-medium text-emerald-600 dark:text-emerald-400">
        {brl.format(row.getValue<number>('revenue'))}
      </div>
    ),
  },
];

export function EventsTable({ data }: { data: EventRow[] }): React.JSX.Element {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={columns.length}
              className="py-12 text-center text-sm text-muted-foreground"
            >
              Nenhum evento ainda — crie e publique um evento para ver as vendas
              aqui.
            </TableCell>
          </TableRow>
        ) : (
          table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
