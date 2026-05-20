// apps/web/src/app/layout.tsx

import type React from 'react';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from '@/components/ui/toaster';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://showpass.com.br'),
  title: {
    template: '%s | ShowPass',
    default: 'ShowPass — Ingressos para os melhores eventos',
  },
  description: 'Compre ingressos para shows, teatro, esportes e muito mais.',
  openGraph: {
    siteName: 'ShowPass',
    type: 'website',
    locale: 'pt_BR',
  },
};

// explicit-function-return-type (eslint do projeto, 'error'): anotar o retorno.
// React 19 removeu o namespace global JSX — usamos React.JSX.Element.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="pt-BR">
      <body className={inter.className}>
        <Toaster />
        {children}
      </body>
    </html>
  );
}
