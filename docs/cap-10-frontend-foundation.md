# Capítulo 10 — Frontend Foundation

> **Objetivo:** Configurar o Next.js 16.2 com App Router, cliente HTTP type-safe com Zod, gerenciamento de auth com Zustand, e os padrões de Server/Client Components.

## O que você vai aprender

- Next.js 16.2 App Router — layouts aninhados, Server vs Client Components
- API client com Zod validation — sem `any`, erros tipados
- Zustand para estado de auth + persist no localStorage
- Middleware Next.js para proteção de rotas (redirect se não autenticado)
- Refresh token automático — access token renovado transparentemente
- Decodificação de JWT no cliente para popular dados do usuário sem round-trip extra
- `tsconfig.json` strict — zero tolerância a tipos fracos

---

## Passo 10.1 — Estrutura do `apps/web`

```
apps/web/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root layout (fontes, providers)
│   │   ├── (public)/               # Route group — rotas sem auth
│   │   │   ├── page.tsx            # Home: busca de eventos
│   │   │   ├── login/
│   │   │   │   ├── page.tsx        # Server: <Suspense> wrapper (Next exige p/ useSearchParams)
│   │   │   │   └── login-form.tsx  # Client: formulário UNIFICADO (organizer | comprador)
│   │   │   ├── events/[slug]/
│   │   │   │   └── page.tsx        # Página do evento (SSR)
│   │   │   └── search/
│   │   │       └── page.tsx        # Resultados de busca
│   │   ├── (buyer)/                # Route group — área do comprador
│   │   │   ├── checkout/
│   │   │   │   ├── page.tsx        # Checkout
│   │   │   │   └── success/
│   │   │   │       └── page.tsx    # Confirmação de compra
│   │   │   └── my-tickets/
│   │   │       └── page.tsx        # Ingressos do comprador
│   │   └── (organizer)/            # Route group — painel do organizador
│   │       ├── dashboard/
│   │       │   └── page.tsx
│   │       └── events/
│   │           ├── page.tsx        # Lista de eventos
│   │           └── [id]/
│   │               └── page.tsx    # Edição de evento
│   ├── lib/
│   │   ├── api-client.ts           # HTTP client com Zod
│   │   └── api/
│   │       ├── events.ts           # Funções de API: eventos
│   │       ├── bookings.ts         # Funções de API: reservas
│   │       └── auth.ts             # Funções de API: auth
│   ├── store/
│   │   └── auth-store.ts           # Zustand: tokens, user
│   ├── components/
│   │   ├── ui/                     # shadcn/ui (gerado)
│   │   ├── events/
│   │   └── layout/
│   ├── env.d.ts                    # Tipagem de process.env (NEXT_PUBLIC_*, JWT_PUBLIC_KEY)
│   └── middleware.ts               # Proteção de rotas
├── package.json
└── next.config.ts
```

> **Uma tela de login unificada (`/login`):** um seletor escolhe organizer ou comprador. O tipo decide apenas a *rota* do auth-service (`/auth/organizers/login` vs `/auth/buyers/login`) — o body é idêntico. O middleware redireciona qualquer rota protegida para `/login?as=<tipo>&redirect=<origem>`, então o checkout (buyer) e o dashboard (organizer) usam a mesma porta de entrada sem ambiguidade.

---

## Passo 10.2 — `next.config.ts`

```typescript
// apps/web/next.config.ts

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @showpass/types resolve para o `dist` buildado (condição `import`/`default`).
  // O source TS cru usa specifiers NodeNext `.js` que o Turbopack NÃO sabe mapear
  // para `.ts` (não tem extensionAlias). O source só é exposto via a condição custom
  // `showpass-dev` — pedida só pelo backend e NÃO injetada pelo Next —, enquanto o
  // web fica com o `dist` (.js reais). transpilePackages mantido para o Next
  // processar o ESM do pacote sem fricção.
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
```

> **Resolução do `@showpass/types` no web:** o pacote expõe `src/` (TS cru, com specifiers NodeNext `.js`) só na condição custom `showpass-dev`, pedida apenas pelo backend. O Turbopack **não** sabe mapear `./x.js` → `./x.ts` (não tem `extensionAlias`) — então o web resolve pela condição `import`/`default`, que aponta para o `dist/` **buildado** (`.js` reais). Cuidado importante: o nome da condição **não** pode ser `development`, porque o Next a injeta automaticamente em dev mode e o web acabaria pegando o `src/` cru — daí o nome custom `showpass-dev`. Consequência prática: ao mudar `packages/types/src`, rode `pnpm --filter @showpass/types build` para o web ver. `transpilePackages` fica mantido só para o Next processar o ESM do pacote sem fricção.
>
> **Por que removemos `experimental.ppr`:** em Next 16.2 a feature foi mesclada em `cacheComponents` (Server Components com cache explícito via `'use cache'`). O modo antigo deixou de existir; ativá-lo aqui no Capítulo de fundação adicionaria complexidade sem ganho — fica opt-in para capítulos posteriores.

---

### `src/env.d.ts` — tipagem de `process.env`

```typescript
// apps/web/src/env.d.ts
//
// Tipa process.env como propriedades DECLARADAS (não index signature).
// Sem isto, `process.env.NEXT_PUBLIC_API_URL` (notação ponto, EXIGIDA pelo
// Next para substituição estática de NEXT_PUBLIC_*) dispara TS4111 sob
// `noPropertyAccessFromIndexSignature` do tsconfig base.

declare namespace NodeJS {
  interface ProcessEnv {
    readonly NEXT_PUBLIC_API_URL: string;
    readonly NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: string;
    readonly JWT_PUBLIC_KEY: string;
    readonly NODE_ENV: 'development' | 'production' | 'test';
  }
}
```

> **Por que isso é necessário:** o Next.js exige que variáveis `NEXT_PUBLIC_*` sejam acessadas em notação ponto (`process.env.NEXT_PUBLIC_API_URL`) — só assim o build estático substitui o valor inline no bundle. Mas o `tsconfig.base.json` do projeto liga `noPropertyAccessFromIndexSignature`, que proíbe ponto em propriedades de index signature (o tipo padrão de `process.env` é `Record<string, string | undefined>`). A declaração acima resolve o conflito **declarando** as propriedades — passam a aceitar notação ponto **e** ficam tipadas.

---

## Passo 10.3 — API Client type-safe

```typescript
// apps/web/src/lib/api-client.ts
//
// Cliente HTTP centralizado com:
// - Validação de resposta com Zod (runtime type safety)
// - Auto-refresh do access token ao receber 401
// - Tipagem forte: ApiError, ApiResponse
// - Base URL configurável por ambiente
//
// Por que useAuthStore.getState() e não um export de função wrapper?
// O Zustand expõe .getState() exatamente para acesso fora de componentes React.
// Chamar useAuthStore() (hook) fora de componentes viola as regras dos hooks.

import { z, ZodSchema } from 'zod';
import { RefreshResponseSchema } from '@showpass/types';
import { useAuthStore } from '../store/auth-store';

// O API Gateway roda na :3000; o frontend Next.js roda na :3001
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// Erro tipado — não usar Error genérico
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly errors?: Array<{ field: string; message: string }>,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

/**
 * Faz uma request ao API Gateway e valida a resposta com o Zod schema fornecido.
 * Se a resposta não corresponder ao schema, lança ApiError (não retorna `any`).
 */
export async function apiRequest<T>(
  path: string,
  schema: ZodSchema<T>,
  options: RequestOptions = {},
): Promise<T> {
  const { skipAuth = false, ...fetchOptions } = options;

  const headers = new Headers(fetchOptions.headers);
  headers.set('Content-Type', 'application/json');

  // Adicionar token de autenticação via .getState() — padrão idiomático Zustand fora de componentes
  if (!skipAuth) {
    const accessToken = useAuthStore.getState().accessToken;
    if (accessToken) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...fetchOptions,
    headers,
  });

  // Tentar renovar o token automaticamente se receber 401
  if (response.status === 401 && !skipAuth) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      // Retry com o novo token
      return apiRequest(path, schema, options);
    }
    // Refresh falhou — logout
    useAuthStore.getState().logout();
    throw new ApiError(401, 'Sessão expirada. Faça login novamente.');
  }

  // Parsear corpo da resposta
  let body: unknown;
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  if (!response.ok) {
    const err = body as { message?: string; errors?: Array<{ field: string; message: string }> };
    throw new ApiError(
      response.status,
      err.message ?? `HTTP ${response.status}`,
      err.errors,
      response.headers.get('x-request-id') ?? undefined,
    );
  }

  // Validar a resposta com o schema Zod
  // Se a API retornar um formato inesperado, o erro é capturado aqui antes de chegar no componente
  const result = schema.safeParse(body);
  if (!result.success) {
    // Zod 4: a lista de erros está em .issues (não .errors)
    console.error('[API] Resposta inválida do servidor:', result.error.issues);
    throw new ApiError(500, 'Resposta inesperada do servidor');
  }

  return result.data;
}

async function tryRefreshToken(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',  // enviar httpOnly cookie com o refresh token
    });

    // O endpoint pode retornar { statusCode, message } em caso de token inválido/expirado
    const data: unknown = await response.json();

    // Validar com schema — distingue resposta de sucesso de resposta de erro
    const parsed = RefreshResponseSchema.safeParse(data);
    if (!parsed.success) return false;

    useAuthStore.getState().setAuth(parsed.data.accessToken, parsed.data.expiresIn);
    return true;
  } catch {
    return false;
  }
}
```

---

## Passo 10.4 — API Functions

```typescript
// apps/web/src/lib/api/events.ts
//
// Funções de API para eventos — usadas em Server Components (fetch server-side)
// e Client Components (fetch client-side). Mesmo código, dois contextos.

import { apiRequest } from '../api-client';
import {
  EventResponseSchema,
  EventPublicResponseSchema,
  z,
} from '@showpass/types';

const EventListResponseSchema = z.object({
  items: z.array(EventResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

const SearchResponseSchema = z.object({
  hits: z.array(EventResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

// GET /events/:slug/public devolve o detalhe COMPLETO (venue.sections.seats,
// ticketBatches, organizer) — não o resumo de listagem. Por isso validamos
// com EventPublicResponseSchema, não EventResponseSchema. O cap-11 consome
// venue.sections para montar o mapa de assentos; se usássemos o schema
// resumido, o Zod faria strip desses campos e o SeatMap quebraria.
export async function getEventBySlug(slug: string) {
  return apiRequest(
    `/events/${slug}/public`,
    EventPublicResponseSchema,
    { skipAuth: true },
  );
}

export async function searchEvents(params: {
  q?: string;
  city?: string;
  state?: string;
  category?: string;
  page?: number;
}) {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.city) query.set('city', params.city);
  if (params.state) query.set('state', params.state);
  if (params.category) query.set('category', params.category);
  query.set('page', String(params.page ?? 1));

  return apiRequest(
    `/search/events?${query.toString()}`,
    SearchResponseSchema,
    { skipAuth: true },
  );
}

export async function getMyEvents(page = 1) {
  return apiRequest(
    `/events?page=${page}`,
    EventListResponseSchema,
  );
}
```

---

## Passo 10.5 — Zustand Auth Store

```typescript
// apps/web/src/store/auth-store.ts
//
// Estado de autenticação com persist no localStorage.
//
// IMPORTANTE: armazenamos APENAS o access token no localStorage.
// O refresh token está em httpOnly cookie — JavaScript nunca consegue lê-lo.
//
// Por que decodificar o JWT no cliente em vez de esperar um campo `user` da API?
// O auth-service retorna apenas { accessToken, expiresIn }. Todos os dados do
// usuário (id, email, type, organizerId) já estão nos claims do JWT.
// Decodificar localmente evita um round-trip extra e mantém o contrato simples.
// ATENÇÃO: decodificar ≠ verificar. A verificação de assinatura acontece no
// middleware (Edge Runtime com jose) e no API Gateway — nunca confie nos claims
// do JWT para decisões de segurança no lado do cliente.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { jwtDecode } from 'jwt-decode';

interface AuthUser {
  id: string;       // claim "sub"
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
}

// Claims que o auth-service emite no JWT
interface JwtClaims {
  sub: string;
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
  exp: number;
}

interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  expiresAt: number | null;  // timestamp em ms

  // Actions
  setAuth: (token: string, expiresIn: number) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
  isTokenExpired: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      user: null,
      expiresAt: null,

      // Recebe o token bruto, decodifica os claims e popula `user` em uma única ação.
      // Assim o componente de login não precisa conhecer a estrutura do JWT.
      setAuth: (token, expiresIn) => {
        const claims = jwtDecode<JwtClaims>(token);
        set({
          accessToken: token,
          expiresAt: Date.now() + expiresIn * 1000,
          user: {
            id: claims.sub,
            email: claims.email,
            type: claims.type,
            organizerId: claims.organizerId,
          },
        });
      },

      logout: () => {
        set({ accessToken: null, user: null, expiresAt: null });
        // Expira o cookie access_token (espelho do token p/ middleware/SSR).
        // typeof document evita ReferenceError se logout rodar no SSR.
        if (typeof document !== 'undefined') {
          document.cookie = 'access_token=; path=/; max-age=0; SameSite=Lax';
        }
        // Chamar endpoint de logout para revogar o refresh token no servidor (cookie httpOnly)
        fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
      },

      isAuthenticated: () => {
        const state = get();
        return !!state.accessToken && !state.isTokenExpired();
      },

      isTokenExpired: () => {
        const { expiresAt } = get();
        if (!expiresAt) return true;
        // Considerar expirado 30s antes do tempo real (margem para latência de rede)
        return Date.now() >= expiresAt - 30_000;
      },
    }),
    {
      name: 'showpass-auth',
      storage: createJSONStorage(() => localStorage),
      // Persistir apenas o que é necessário para restaurar a sessão após reload
      partialize: (state) => ({
        accessToken: state.accessToken,
        user: state.user,
        expiresAt: state.expiresAt,
      }),
    },
  ),
);
```

> **`jwt-decode` vs `jose`:** `jwt-decode` apenas decodifica o payload base64 — sem verificar assinatura. Isso é suficiente para popular a UI. A verificação real ocorre no middleware (Edge Runtime) e no API Gateway. Adicione a dependência: `pnpm --filter @showpass/web add jwt-decode`.

---

## Passo 10.6 — Middleware de Proteção de Rotas

```typescript
// apps/web/src/middleware.ts
//
// Executa no Edge Runtime antes de cada request.
// Redireciona para login se a rota exige autenticação.
//
// Por que Edge Runtime e não Node.js middleware?
// O Edge Runtime executa antes do servidor renderizar a página, permitindo
// redirect sem flash de conteúdo protegido. O Node.js runtime renderizaria
// o conteúdo primeiro e só depois aplicaria o redirect.
//
// JWT_PUBLIC_KEY deve ser configurada como variável de ambiente do frontend
// (apps/web/.env.local). O Edge Runtime não herda segredos do backend — cada
// processo é isolado. Exporte a chave pública do auth-service e cole aqui.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify, importSPKI } from 'jose';

// Rotas que exigem autenticação de organizer
const ORGANIZER_ROUTES = ['/dashboard', '/events/create', '/events/edit'];

// Rotas que exigem autenticação de buyer
const BUYER_ROUTES = ['/checkout', '/my-tickets'];

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  const isOrganizerRoute = ORGANIZER_ROUTES.some((r) => pathname.startsWith(r));
  const isBuyerRoute = BUYER_ROUTES.some((r) => pathname.startsWith(r));

  if (!isOrganizerRoute && !isBuyerRoute) {
    return NextResponse.next();
  }

  // Extrair token do header ou do cookie `access_token`. O Edge Runtime NÃO
  // enxerga o localStorage (onde o Zustand guarda o token) — só cookies e
  // headers. Por isso o login (Passo 10.8) grava o token também num cookie:
  // sem ele, toda rota protegida cairia no redirect abaixo mesmo logado.
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '') ??
    request.cookies.get('access_token')?.value;

  if (!token) {
    return redirectToLogin(request, isOrganizerRoute ? 'organizer' : 'buyer');
  }

  try {
    // Verificar o JWT com a chave pública — importSPKI é compatível com Edge Runtime
    // A chave pública não é segredo; pode estar em variável NEXT_PUBLIC_ se preferir
    const publicKeyPem = process.env.JWT_PUBLIC_KEY!.replace(/\\n/g, '\n');
    const publicKey = await importSPKI(publicKeyPem, 'RS256');

    const { payload } = await jwtVerify(token, publicKey, {
      audience: 'showpass-api',
      issuer: 'showpass-auth',
    });

    const userType = payload.type as string;

    // Verificar tipo de usuário correto para a rota
    if (isOrganizerRoute && userType !== 'organizer') {
      return redirectToLogin(request, 'organizer');
    }

    if (isBuyerRoute && userType !== 'buyer') {
      return redirectToLogin(request, 'buyer');
    }

    return NextResponse.next();
  } catch {
    return redirectToLogin(request, isOrganizerRoute ? 'organizer' : 'buyer');
  }
}

function redirectToLogin(request: NextRequest, type: 'organizer' | 'buyer'): NextResponse {
  // Login UNIFICADO em /login — a página tem um seletor organizer|comprador.
  // Passamos `as` para a página pré-selecionar a aba certa (UX), e `redirect`
  // para voltar à rota original após autenticar.
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('as', type);
  url.searchParams.set('redirect', request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/events/create',
    '/events/edit/:path*',
    '/checkout/:path*',
    '/my-tickets/:path*',
  ],
};
```

> **Variável `JWT_PUBLIC_KEY` no frontend:** O Edge Runtime roda em processo separado do backend. Configure `JWT_PUBLIC_KEY` em `apps/web/.env.local` com o conteúdo da chave pública RSA do auth-service (o mesmo arquivo `.pem` que o auth-service usa internamente). A chave pública não é segredo.

---

## Passo 10.7 — Root Layout e Providers

```typescript
// apps/web/src/app/layout.tsx

import type React from 'react';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import { Toaster } from '@/components/ui/toaster';
import { Header } from '@/components/header';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://showpass.com.br'),
  title: {
    template: '%s | ShowPass',
    default: 'ShowPass — Ingressos para os melhores eventos',
  },
  description: 'Compre ingressos para shows, teatro, esportes e muito mais.',
  openGraph: { siteName: 'ShowPass', type: 'website', locale: 'pt_BR' },
};

// Aplica `.dark` no <html> ANTES da hidratação (default: dark). Sem isso a
// página pisca claro→escuro no 1º paint. beforeInteractive injeta no <head>.
const themeScript = `(function(){try{var t=localStorage.getItem('showpass-theme')||'dark';if(t==='dark'){document.documentElement.classList.add('dark');}}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    // suppressHydrationWarning: o script muta a className do <html> antes do
    // React hidratar → servidor e cliente divergem nesse atributo.
    <html lang="pt-BR" suppressHydrationWarning>
      <body className={inter.className}>
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
```

### Tema dark/light (Tailwind v4, sem dependência extra)

Tailwind v4 ativa dark mode por classe com `@custom-variant`. As cores base trocam
via CSS vars; o resto usa utilities `dark:`.

```css
/* apps/web/src/app/globals.css */
@import 'tailwindcss';
@custom-variant dark (&:where(.dark, .dark *));

:root  { --background:#ffffff; --foreground:#0a0a0a; --muted:#4b5563; color-scheme:light; }
.dark  { --background:#0a0a0a; --foreground:#ededed; --muted:#9ca3af; color-scheme:dark; }

body { margin:0; background:var(--background); color:var(--foreground); }
```

O **ThemeToggle** (client) lê/escreve `localStorage['showpass-theme']` e alterna a
classe `.dark` no `<html>`. Um gate `mounted` evita mismatch de hidratação (no SSR
não sabemos o tema do cliente):

```typescript
// apps/web/src/components/theme-toggle.tsx — 'use client'
const next = theme === 'dark' ? 'light' : 'dark';
document.documentElement.classList.toggle('dark', next === 'dark');
localStorage.setItem('showpass-theme', next);
```

> Por que **não** usar uma lib de UI (NextUI/HeroUI) ou `next-themes`? O projeto é
> Tailwind v4 + componentes próprios. Dark mode é nativo do Tailwind, e o no-flash
> são ~5 linhas — adicionar um design system inteiro só incharia o bundle e criaria
> conflito de stack.

### Header com estado de autenticação

O `Header` reflete o login lendo o `useAuthStore`. Como o store (Zustand/persist) só
hidrata no cliente, o bloco de auth fica atrás de `mounted` — o servidor sempre
renderiza "deslogado", e o cliente troca para `email + Sair` após hidratar.

```typescript
// apps/web/src/components/header.tsx — 'use client' (trecho)
const authed = mounted && isAuthenticated();
// ...
{authed ? (
  <>
    <span>{user?.email}</span>
    <button onClick={handleLogout}>Sair</button>   {/* logout() limpa store+cookie */}
  </>
) : (
  <Link href="/login">Entrar</Link>
)}
```

> Sem isso, a home (estática) sempre mostrava "Entrar" mesmo logado — parecia que o
> login não pegava. O token sempre esteve no localStorage + cookie; faltava só a UI
> refletir. `handleLogout` faz `router.refresh()` para revalidar Server Components
> que liam o cookie `access_token`.

### Design system: shadcn/ui (Base UI + Tailwind v4)

Em vez de uma lib de componentes "pesada" (NextUI/HeroUI/MUI — engine de estilo
próprio, conflito com Tailwind, atraso no suporte a React 19/Next 16), adotamos o
**shadcn/ui**: os componentes são **copiados** para `components/ui/` e viram *nossos*.

```bash
# Inicializa (preset base-nova → Base UI + Lucide; Tailwind v4 detectado)
pnpm dlx shadcn@latest init -d
# Adiciona componentes sob demanda
pnpm dlx shadcn@latest add card table chart sidebar badge
```

O que isso muda no projeto:
- **`components.json`** + **`globals.css`** ganha o token set completo (`--background`,
  `--card`, `--primary`, `--sidebar-*`, `--chart-*`) em `:root`/`.dark` + `@theme inline`.
  O `@custom-variant dark` e o ThemeToggle continuam valendo (mesma classe `.dark`).
- **`cn`** ([lib/utils.ts](apps/web/src/lib/utils.ts)) passa a usar `clsx` + `tailwind-merge`
  (dedupe de classes Tailwind conflitantes — necessário para os overrides via `className`).
- **Polimorfismo é `render`, não `asChild`.** O preset base-nova usa **Base UI**
  (`useRender`), então onde o Radix faria `<Button asChild><Link/></Button>` aqui é
  `<Button render={<Link href="..." />}>Label</Button>`.
- **Lint:** os arquivos de `components/ui/**` são *vendored* (regenerados via CLI) e não
  seguem o `explicit-function-return-type` do projeto → são **ignorados** no
  [eslint.config.mjs](eslint.config.mjs) (mesmo tratamento de `prisma/generated`).

> **Paleta Horizon UI:** os valores dos tokens em `globals.css` foram remapeados para a
> paleta do [Horizon UI](https://horizon-ui.com) free (marca `#422AFB`/`#7551FF`, fundo
> `#F4F7FE` / navy `#0b1437`, texto secundário `#707EAE`), com fonte **DM Sans** e a
> sombra suave `shadow-card`. Como o remap é nos tokens semânticos do shadcn, o app
> inteiro (sidebar, cards, botões) herda a identidade de uma vez — sem reescrever
> classes componente a componente. O ThemeToggle continua valendo (mesma classe `.dark`).

---

## Passo 10.8 — Login unificado (`page.tsx` + `login-form.tsx`)

> **Por que UMA página e não duas?** O auth-service tem rotas separadas
> (`/auth/organizers/login` e `/auth/buyers/login`) porque organizers e buyers
> vivem em tabelas distintas. Mas, do ponto de vista de UX e roteamento, ter
> duas páginas (`/login` e `/buyer/login`) gera fricção: o middleware precisa
> decidir para qual redirecionar; o checkout (cap-12) é fluxo de buyer e o
> dashboard (cap-13) é de organizer — ambos precisam mandar para "a tela de
> login". Solução: **uma rota `/login`** com um seletor organizer|comprador.
> O `redirectToLogin` do middleware já passa `?as=organizer|buyer` para
> pré-selecionar a aba.

> **Por que DOIS arquivos (`page.tsx` + `login-form.tsx`)?** O formulário usa
> `useSearchParams()` para ler `?as=` e `?redirect=`. Em Next 16, qualquer
> Client Component que chame `useSearchParams()` precisa estar dentro de um
> `<Suspense>` boundary — senão o build estático falha com
> `missing-suspense-with-csr-bailout`. O padrão idiomático é separar:
>
> - **`page.tsx`** — Server Component que só envolve `<LoginForm />` em
>   `<Suspense>` (fallback é o esqueleto da tela).
> - **`login-form.tsx`** — Client Component com `'use client'`, hooks e a
>   lógica do formulário.

```typescript
// apps/web/src/app/(public)/login/page.tsx
//
// Server Component que envolve o LoginForm (client) em <Suspense>.
// Next exige Suspense para páginas com useSearchParams() na geração
// estática — sem isso, `next build` falha (missing-suspense-with-csr-bailout).

import type React from 'react';
import { Suspense } from 'react';
import { LoginForm } from './login-form';

export default function LoginPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={<div className="min-h-screen bg-[#0a0a0f]" />}
    >
      <LoginForm />
    </Suspense>
  );
}
```

```typescript
// apps/web/src/app/(public)/login/login-form.tsx
//
// Componente client do login UNIFICADO. Usa useSearchParams() — por isso
// vive separado da page (que o envolve em <Suspense>: requisito do Next
// para static generation de páginas com useSearchParams).
'use client';

import type React from 'react';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/store/auth-store';
import { LoginRequestSchema, LoginResponseSchema } from '@showpass/types';
import { ApiError } from '@/lib/api-client';

// Reutiliza o schema do @showpass/types — mesma fonte da verdade do backend.
type LoginFormValues = z.infer<typeof LoginRequestSchema>;
type LoginAs = 'organizer' | 'buyer';

export function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);

  // ?as=organizer|buyer (vindo do middleware) pré-seleciona a aba.
  const initialAs: LoginAs =
    searchParams.get('as') === 'organizer' ? 'organizer' : 'buyer';
  const [loginAs, setLoginAs] = useState<LoginAs>(initialAs);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({ resolver: zodResolver(LoginRequestSchema) });

  const onSubmit = async (data: LoginFormValues): Promise<void> => {
    setError(null);

    const route =
      loginAs === 'organizer'
        ? '/auth/organizers/login'
        : '/auth/buyers/login';

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}${route}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          credentials: 'include',
        },
      );

      if (!response.ok) {
        const err = (await response.json()) as { message: string };
        setError(err.message);
        return;
      }

      const raw: unknown = await response.json();
      const parsed = LoginResponseSchema.safeParse(raw);
      if (!parsed.success) {
        console.error('[login] Resposta inesperada:', parsed.error.issues);
        setError('Resposta inesperada do servidor.');
        return;
      }

      // setAuth decodifica o JWT e popula `user` a partir dos claims (Zustand
      // → localStorage, lido por Client Components via api-client).
      setAuth(parsed.data.accessToken, parsed.data.expiresIn);

      // Também grava o access token num cookie NÃO-httpOnly. Por quê?
      //   - O middleware Edge (Passo 10.6) só enxerga cookies/headers, nunca o
      //     localStorage — sem este cookie, /dashboard e /checkout
      //     redirecionariam para /login mesmo logado.
      //   - Server Components (ex: dashboard do cap-13) leem o token via
      //     next/headers cookies() para repassar ao backend no fetch SSR.
      // Não é regressão de segurança: o token já vivia no localStorage (também
      // exposto a XSS). O refresh token continua httpOnly, fora do alcance do JS.
      document.cookie = `access_token=${parsed.data.accessToken}; path=/; max-age=${String(parsed.data.expiresIn)}; SameSite=Lax`;

      const fallback = loginAs === 'organizer' ? '/dashboard' : '/';
      router.push(searchParams.get('redirect') ?? fallback);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Erro de conexão. Tente novamente.',
      );
    }
  };

  return (
    // Wrapper exibido aqui simplificado — o visual real é o dark "Neural Access"
    // descrito logo abaixo (fundo #0a0a0f, card glass, glow, inputs neon).
    <div className="relative flex min-h-screen items-center justify-center bg-[#0a0a0f]">
      <div className="w-full max-w-md rounded-[20px] border border-blue-500/20 bg-[rgba(15,15,20,0.95)] p-10 backdrop-blur-xl">
        <h1 className="text-2xl font-bold text-center mb-6 text-slate-50">ShowPass</h1>

        <div className="grid grid-cols-2 gap-1 p-1 mb-6 bg-gray-100 rounded-lg">
          {(['buyer', 'organizer'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setLoginAs(t);
              }}
              className={
                'py-2 text-sm rounded-md transition ' +
                (loginAs === t
                  ? 'bg-white shadow font-medium'
                  : 'text-gray-500')
              }
            >
              {t === 'buyer' ? 'Comprador' : 'Organizador'}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            // no-misused-promises: handleSubmit retorna Promise; envolver com void
            void handleSubmit(onSubmit)(e);
          }}
          className="space-y-4"
        >
          <div>
            <Input
              type="email"
              placeholder="seu@email.com"
              {...register('email')}
              aria-invalid={!!errors.email}
            />
            {errors.email && (
              <p className="text-red-500 text-sm mt-1">
                {errors.email.message}
              </p>
            )}
          </div>

          <div>
            <Input
              type="password"
              placeholder="Senha"
              {...register('password')}
              aria-invalid={!!errors.password}
            />
            {errors.password && (
              <p className="text-red-500 text-sm mt-1">
                {errors.password.message}
              </p>
            )}
          </div>

          {error && (
            <p className="text-red-500 text-sm text-center">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Entrando...' : 'Entrar'}
          </Button>
        </form>
      </div>
    </div>
  );
}
```

### Visual "Neural Access" (login + home imersivas)

A **lógica** acima (tabs, react-hook-form, `onSubmit`) é a fonte da verdade; o
**visual** foi reestilizado para um dark glassmorphism inspirado no template MIT
[puikinsh/login-forms](https://github.com/puikinsh/login-forms) (`forms/ai-assistant`).
No `login-form.tsx` o card branco vira uma tela imersiva:

- Fundo `#0a0a0f` com **nós neurais** (pontos azuis pulsantes) e um **glow radial
  rotativo** (`@keyframes neural-glow` em `globals.css`).
- Card glass: `bg-[rgba(15,15,20,0.95)]` + `backdrop-blur-xl` + borda `border-blue-500/20`.
- Logo com anéis `animate-ping` + núcleo girando (`Sparkles`, `animate-[spin_8s...]`).
- Inputs glass (`<input>` cru, não o shadcn) com **dot indicador** pulsante e **toggle
  de senha** (olho); botão **gradiente** `from-blue-500 to-violet-500`.

```typescript
// O input recebe suppressHydrationWarning: extensões (Kaspersky, gerenciadores de
// senha) injetam atributos no campo ANTES do React hidratar → mismatch. Suprimir é
// o fix recomendado pelo React e afeta só os atributos deste elemento.
<input type="email" {...register('email')} suppressHydrationWarning className={inputClass} />
```

A **home** (`app/page.tsx`) usa a mesma linguagem (fundo neural, logo brilhante,
título em gradiente `bg-clip-text`) com **um único CTA "Entrar"**. Para isso, o
`Header` global **some** na home e nas telas imersivas — em
[components/header.tsx](apps/web/src/components/header.tsx):

```typescript
if (pathname === '/' || HIDE_HEADER_PREFIXES.some((p) => pathname.startsWith(p))) {
  return null;  // '/', '/login' e rotas do organizer não mostram o Header global
}
```

---

## Passo 10.9 — Variáveis de Ambiente

```bash
# apps/web/.env.local

# URL do API Gateway — porta 3000 (NÃO a porta do frontend)
# O frontend em si roda na :3001; as requests de API vão para :3000
NEXT_PUBLIC_API_URL=http://localhost:3000

# Chave pública do Stripe (safe para expor no cliente)
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...

# Chave pública RSA do auth-service — usada pelo middleware Edge Runtime para verificar JWT
# Não é segredo (chave pública), mas não precisa de prefixo NEXT_PUBLIC_
# porque só o middleware no servidor a usa
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
```

```bash
# apps/web/.env.example  (commitar no repositório)

NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_SUBSTITUA
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nSUBSTITUA\n-----END PUBLIC KEY-----"
```

> **Porta 3001 é do frontend, 3000 é do gateway.** Um erro comum é colocar `NEXT_PUBLIC_API_URL=http://localhost:3001` achando que é "a própria aplicação". A aplicação Next.js sobe na :3001 (configurado via `PORT=3001` ou `next dev -p 3001`); o API Gateway escuta na :3000. Todo `fetch` para `/auth/...`, `/events/...` etc. deve ir para :3000.

---

## Testando na prática

> **Guia completo e atualizado:** ver [docs/guia-de-testes.md](guia-de-testes.md).
> Esta seção traz um resumo focado no frontend (cap-10).

### O que precisa estar rodando

```bash
# Infraestrutura
make infra-up

# Serviços (4 terminais)
pnpm --filter @showpass/auth-service dev     # :3006
pnpm --filter @showpass/api-gateway  dev     # :3000
pnpm --filter @showpass/event-service dev    # :3003
pnpm --filter @showpass/web          dev     # :3001
```

### Passo a passo no browser

**1. Home imersiva**

Acesse `http://localhost:3001` — fundo escuro com nós neurais pulsantes, logo animado,
título em gradiente e **um único botão "Entrar"** (sem Header nessa tela).

**2. Spinner de loading**

Clique em **Entrar**:
- Spinner cobre a tela instantaneamente (bloqueia clique duplo)
- Permanece até o formulário de login renderizar completamente

**3. Tela de login "Neural Access"**

Você deve ver:
- Card glass com glow rotativo e borda azul
- Logo com anéis `animate-ping`
- Abas **Comprador | Organizador**
- Inputs com dot indicador azul pulsante e toggle de senha (ícone olho)
- Botão gradiente azul→violeta

**4. Registrar e logar como organizer**

```bash
# Registrar (via API — uma única vez)
curl -s -X POST http://localhost:3000/auth/organizers/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"org@showpass.com","password":"Senha@12345","name":"Demo"}' \
  | python3 -m json.tool
```

Na tela de login: aba **Organizador** → `org@showpass.com` / `Senha@12345` → **Entrar**.

**5. Spinner contínuo login → dashboard**

O overlay permanece desde o clique até o `/dashboard` terminar de carregar — sem flash
entre o fim da request de auth e o início do carregamento da próxima página.

**6. Verificar tokens no DevTools (F12)**

| Local | O que verificar |
|---|---|
| Application → Cookies | `refresh_token` com `httpOnly` (OWASP A07) |
| Application → Local Storage → `showpass-auth` | `accessToken`, `expiresAt`, `user.type: "organizer"` |
| Network | `POST :3000/auth/organizers/login` → 200 |

**7. Auto-redirect de usuário logado**

Estando logado como organizer, navegue para `http://localhost:3001/` ou
`http://localhost:3001/login` — o middleware Edge redireciona instantaneamente
para `/dashboard` sem flash de conteúdo.

**8. Proteção de rota**

Faça logout e tente acessar `http://localhost:3001/dashboard` — redireciona para
`/login?as=organizer&redirect=%2Fdashboard`.

**9. Logout sem erro no Network**

Clique em **Sair** com o DevTools aberto (filtro "logout"):
- `POST localhost:3000/auth/logout` → **204** (não 401/404)
- Header `Authorization: Bearer <token>` presente na request

**10. Tema dark/light**

No topbar do painel, clique no toggle (sol/lua). O tema persiste em
`localStorage['showpass-theme']` e aplica sem flash na próxima carga (script
`beforeInteractive` no `<head>`).

---

## Recapitulando

1. **App Router + Turbopack** — `transpilePackages: ['@showpass/types']` + `resolveExtensions` no Turbopack permitem consumir o workspace em TS cru sem build step; PPR fica opt-in para um capítulo posterior (foi mesclado em `cacheComponents` no Next 16.2)
2. **API client com Zod** — toda resposta validada em runtime com `.issues` (Zod 4); sem `any` nas fronteiras de rede
3. **JWT decode no cliente** — `jwt-decode` popula `user` a partir dos claims; o backend não precisa retornar um objeto `user` separado
4. **`useAuthStore.getState()`** — acesso idiomático ao store Zustand fora de componentes React; sem wrapper `getAuthStore()`
5. **Auto-refresh transparente** — `tryRefreshToken` valida a resposta com `RefreshResponseSchema` antes de chamar `setAuth`
6. **Middleware Edge Runtime** — verifica JWT com `jose` antes de renderizar a página; redirect sem flash; `JWT_PUBLIC_KEY` é variável do frontend (processo isolado do backend)
7. **httpOnly cookie** para refresh token — JavaScript nunca acessa o token mais poderoso (OWASP A07)
8. **Portas:** API Gateway = `:3000`, frontend Next.js = `:3001`; `NEXT_PUBLIC_API_URL` aponta para `:3000`

---

## Próximo capítulo

[Capítulo 11 → Event Pages & Seat Map](cap-11-event-pages-seat-map.md)
