// apps/web/src/app/page.tsx
//
// Home estática (sem fetch no prerender — a busca de eventos chega no cap-11).
// Mantida simples para não quebrar `next build` quando o gateway está off.

import type React from 'react';
import Link from 'next/link';

export default function HomePage(): React.JSX.Element {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold">ShowPass</h1>
      <p className="text-gray-600">
        Ingressos para shows, teatro, esportes e muito mais.
      </p>
      <Link
        href="/login"
        className="inline-flex h-10 items-center rounded-md bg-blue-600 px-6 text-sm font-medium text-white hover:bg-blue-700"
      >
        Entrar
      </Link>
    </main>
  );
}
