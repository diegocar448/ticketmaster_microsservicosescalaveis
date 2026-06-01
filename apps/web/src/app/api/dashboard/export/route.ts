// apps/web/src/app/api/dashboard/export/route.ts
//
// Route Handler — gera o CSV no servidor e devolve como download (BFF).
//
// Por que não chamar o event-service direto do browser?
//   1. Mantém a lógica de formatação CSV fora do bundle cliente.
//   2. O token fica no cookie server-side (apiRequestServer) — não há fetch
//      autenticado disparado pelo JS do navegador para o gateway.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRequestServer } from '@/lib/api-server';

// Só o que o CSV precisa — topEvents. O resto do payload é ignorado (strip).
const DashboardStatsForExportSchema = z.object({
  topEvents: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      sold: z.number(),
      available: z.number(),
      revenue: z.number(),
    }),
  ),
});

export async function GET(): Promise<NextResponse> {
  const { topEvents } = await apiRequestServer(
    '/events/dashboard/stats',
    DashboardStatsForExportSchema,
  );

  const header = 'Evento,Vendidos,Disponíveis,Receita (R$)\n';
  const rows = topEvents.map((e) =>
    [
      `"${e.title.replace(/"/g, '""')}"`, // escapar aspas (RFC 4180)
      e.sold,
      e.available,
      // pt-BR usa vírgula decimal — que COLIDE com o separador CSV (vírgula).
      // Por isso a receita PRECISA ser aspeada, senão "200,00" viraria duas
      // colunas (200 e 00) ao abrir no Excel/parser RFC 4180.
      `"${e.revenue.toFixed(2).replace('.', ',')}"`,
    ].join(','),
  );
  const csv = header + rows.join('\n');

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      // filename* (RFC 5987) suporta acentos no nome do arquivo
      'Content-Disposition': `attachment; filename="relatorio-${today}.csv"; filename*=UTF-8''relatorio-${today}.csv`,
    },
  });
}
