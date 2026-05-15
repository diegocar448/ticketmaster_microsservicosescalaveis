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
│   │   │   │   └── page.tsx        # Login UNIFICADO (organizer | comprador)
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
  // Turbopack — compilação 400% mais rápida que Webpack; estável desde Next 16
  turbopack: {
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },

  // Validar variáveis de ambiente em build time
  // Se uma var obrigatória estiver faltando, o build falha com mensagem clara
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL!,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
  },

  // Domínios de imagens permitidos (OWASP A05: não carregar imagens de qualquer origem)
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'storage.showpass.com.br' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
    ],
  },

  // Security Headers (complementa o Nginx/Cloudflare)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },

  // PPR (Partial Pre-Rendering) em modo incremental — Next 16.2
  // Cada rota opta individualmente via: export const experimental_ppr = true
  // Isso combina shell estático com streaming de partes dinâmicas por componente
  experimental: {
    ppr: 'incremental',
  },
};

export default nextConfig;
```

> **PPR incremental vs `ppr: true`:** Em Next 16, habilitar `ppr: true` globalmente ativa o modo experimental completo e pode quebrar rotas que ainda não foram testadas com PPR. O modo `'incremental'` é mais seguro: apenas as rotas que exportam `experimental_ppr = true` recebem o tratamento PPR. Nas páginas dos capítulos seguintes mostraremos onde faz sentido ativar.

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

  // Extrair token do header (Client Components) ou cookie (SSR)
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

// Sem tipo de retorno explícito — React 19 removeu o namespace JSX global;
// omitir o tipo é o padrão idiomático para componentes funcionais.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body className={inter.className}>
        {/* Toaster global para notificações */}
        <Toaster />
        {children}
      </body>
    </html>
  );
}
```

---

## Passo 10.8 — Login unificado (Client Component)

> **Por que UMA página e não duas?** O auth-service tem rotas separadas
> (`/auth/organizers/login` e `/auth/buyers/login`) porque organizers e buyers
> vivem em tabelas distintas. Mas, do ponto de vista de UX e de roteamento, ter
> duas páginas (`/login` e `/buyer/login`) gera fricção: o middleware precisa
> decidir para qual redirecionar, o checkout (cap-12) é fluxo de buyer e o
> dashboard (cap-13) é de organizer — ambos precisam mandar para "a tela de
> login". Solução: **uma rota `/login`** com um seletor organizer|comprador.
> O `redirectToLogin` do middleware já passa `?as=organizer|buyer` para
> pré-selecionar a aba.

```typescript
// apps/web/src/app/(public)/login/page.tsx
//
// Login UNIFICADO. Um seletor escolhe o tipo; o tipo decide a ROTA
// (/auth/organizers/login vs /auth/buyers/login) — o body é igual nas duas
// ({ email, password }). Resposta: { accessToken, expiresIn } (sem `user`);
// os dados do usuário saem dos claims do JWT no auth-store (setAuth).
'use client';

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

// Reutiliza o schema do @showpass/types — mesma fonte da verdade que o backend.
// Zod 4: z.email() top-level; evitar z.string().email() (deprecated).
type LoginForm = z.infer<typeof LoginRequestSchema>;

type LoginAs = 'organizer' | 'buyer';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);

  // ?as=organizer|buyer (vindo do middleware) pré-seleciona a aba.
  // Default 'buyer': a maioria do tráfego é de compradores.
  const initialAs: LoginAs =
    searchParams.get('as') === 'organizer' ? 'organizer' : 'buyer';
  const [loginAs, setLoginAs] = useState<LoginAs>(initialAs);

  const { register, handleSubmit, formState: { errors, isSubmitting } } =
    useForm<LoginForm>({ resolver: zodResolver(LoginRequestSchema) });

  const onSubmit = async (data: LoginForm): Promise<void> => {
    setError(null);

    // O tipo escolhido decide a ROTA — o contrato do body é idêntico.
    const route =
      loginAs === 'organizer'
        ? '/auth/organizers/login'
        : '/auth/buyers/login';

    try {
      // NEXT_PUBLIC_API_URL aponta para o API Gateway (:3000), não o frontend
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}${route}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          credentials: 'include', // receber httpOnly cookie do refresh token
        },
      );

      if (!response.ok) {
        const err = await response.json() as { message: string };
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

      // setAuth decodifica o JWT e popula `user` a partir dos claims
      setAuth(parsed.data.accessToken, parsed.data.expiresIn);

      // Volta para a rota original (middleware passou ?redirect=...),
      // ou cai num default coerente com o tipo escolhido.
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm p-8 bg-white rounded-2xl shadow-md">
        <h1 className="text-2xl font-bold text-center mb-6">ShowPass</h1>

        {/* Seletor organizer | comprador */}
        <div className="grid grid-cols-2 gap-1 p-1 mb-6 bg-gray-100 rounded-lg">
          {(['buyer', 'organizer'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setLoginAs(t)}
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

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <Input
              type="email"
              placeholder="seu@email.com"
              {...register('email')}
              aria-invalid={!!errors.email}
            />
            {errors.email && (
              <p className="text-red-500 text-sm mt-1">{errors.email.message}</p>
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
              <p className="text-red-500 text-sm mt-1">{errors.password.message}</p>
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

Este é o primeiro capítulo com interface visual no browser. Você vai ver o fluxo de login funcionando de ponta a ponta.

### O que precisa estar rodando

```bash
# Terminal 1 — infraestrutura
docker compose up -d

# Terminal 2 — auth-service
pnpm --filter @showpass/auth-service run dev          # porta 3006

# Terminal 3 — api-gateway
pnpm --filter @showpass/api-gateway run dev           # porta 3000

# Terminal 4 — frontend
pnpm --filter @showpass/web run dev                   # porta 3001
```

### Passo a passo no browser

**1. Abrir o frontend**

Acesse: **http://localhost:3001**

Você deve ver a home page com header de navegação. Como ainda não há eventos cadastrados, o corpo estará vazio (ou com estado de "nenhum evento").

**2. Acessar a tela de login unificada**

Navegue para: **http://localhost:3001/login**

Você verá o seletor **Comprador | Organizador**. Selecione **Organizador**.

**3. Fazer login como organizer**

Use as credenciais criadas no Cap 04:

- Email: `admin@rockshows.com.br`
- Senha: `Senha@Forte123`

Após o login, você deve ser redirecionado para o dashboard. O `setAuth` decodifica o JWT e popula o store com `{ id, email, type: 'organizer', organizerId }` sem nenhum round-trip adicional ao backend.

**4. Verificar que o token foi armazenado**

Abra o DevTools do browser (F12) → Application → Cookies.

Você verá o cookie `refresh_token` com flag `httpOnly` — **não acessível via JavaScript** (OWASP A07).

No Zustand (Application → Local Storage → `showpass-auth`), você verá o estado de auth com `accessToken`, `expiresAt`, e o objeto `user` populado a partir dos claims do JWT.

**5. Verificar proteção de rota**

Faça logout e tente acessar diretamente: **http://localhost:3001/dashboard**

O middleware Edge Runtime deve redirecionar imediatamente para `/login?redirect=/dashboard` sem flash de conteúdo.

**6. Verificar auto-refresh do token**

Aguarde 15 minutos com a aba aberta (ou manipule `expiresAt` no DevTools → Application → Local Storage para um timestamp passado). Ao fazer qualquer ação, o `apiRequest` chama `tryRefreshToken` que valida a resposta com `RefreshResponseSchema` e chama `setAuth` novamente — sem logout e sem intervenção do usuário.

**7. Verificar request para o API Gateway**

No DevTools → Network, filtre por `localhost:3000`. Todas as requests do frontend passam pelo gateway na porta **3000**, que adiciona os headers `x-user-id` e `x-organizer-id` antes de fazer proxy para os serviços internos. A porta **3001** é exclusivamente a aplicação Next.js — não aparece como destino de API.

---

## Recapitulando

1. **App Router + PPR incremental** — `ppr: 'incremental'` permite que cada rota opte via `export const experimental_ppr = true`; melhor performance sem risco de regressão em rotas não testadas
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
