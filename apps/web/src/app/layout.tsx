// apps/web/src/app/layout.tsx
// Layout raiz do Next.js App Router — implementado no Capítulo 10.
import type React from 'react';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
