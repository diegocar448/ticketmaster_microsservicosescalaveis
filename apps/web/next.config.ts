// apps/web/next.config.ts

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @showpass/types resolve para o `dist` buildado (condição `import`/`default`).
  // O source TS cru usa specifiers NodeNext `.js` que o Turbopack NÃO sabe mapear
  // para `.ts` (ele não tem extensionAlias). Por isso o source só é exposto via a
  // condição custom `showpass-dev` — pedida só pelo backend (`--conditions=showpass-dev`)
  // e NÃO injetada pelo Next —, enquanto o web fica com o `dist` (.js reais).
  // transpilePackages mantido para o Next processar o ESM do pacote sem fricção.
  transpilePackages: ['@showpass/types'],

  // Turbopack — estável desde Next 16
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },

  // Validar variáveis de ambiente em build time
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  },

  // Domínios de imagens permitidos (OWASP A05)
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'storage.showpass.com.br' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
    ],
  },

  // Security headers (complementa Nginx/Cloudflare)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(self)',
          },
        ],
      },
    ];
  },

  // PPR: em Next 16.2 o antigo `experimental.ppr` foi mesclado em
  // `cacheComponents` (muda a semântica de cache e exige diretivas
  // `'use cache'`). Não é necessário no capítulo de fundação — fica
  // opt-in num capítulo posterior, quando houver rota que se beneficie.
};

export default nextConfig;
