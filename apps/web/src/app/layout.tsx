// apps/web/src/app/layout.tsx

import type React from 'react';
import type { Metadata } from 'next';
import { DM_Sans } from 'next/font/google';
import Script from 'next/script';
import { Toaster } from '@/components/ui/toaster';
import { Header } from '@/components/header';
import './globals.css';
import { cn } from '@/lib/utils';

// DM Sans — a fonte do Horizon UI (var --font-sans, usada pelo @theme/@layer base).
const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-sans' });

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

// Script no-flash: aplica `.dark` no <html> ANTES da hidratação, lendo o tema
// salvo (default: dark). Sem isso, a página pisca claro→escuro no 1º paint.
const themeScript = `(function(){try{var t=localStorage.getItem('showpass-theme')||'dark';if(t==='dark'){document.documentElement.classList.add('dark');}}catch(e){}})();`;

// explicit-function-return-type (eslint do projeto, 'error'): anotar o retorno.
// React 19 removeu o namespace global JSX — usamos React.JSX.Element.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    // suppressHydrationWarning: o script acima muta a className do <html> antes
    // do React hidratar, então o servidor e o cliente divergem nesse atributo.
    <html
      lang="pt-BR"
      suppressHydrationWarning
      className={cn('font-sans', dmSans.variable)}
    >
      <body>
        <Script id="theme-no-flash" strategy="beforeInteractive">
          {themeScript}
        </Script>
        <Toaster />
        <Header />
        {children}
      </body>
    </html>
  );
}
