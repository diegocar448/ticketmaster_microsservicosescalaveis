# Capítulo 10 — Frontend Foundation

> **Objetivo:** Configurar o Next.js 16 com App Router, cliente HTTP type-safe com Zod, gerenciamento de auth com Zustand, e os padrões de Server/Client Components.

## O que você vai aprender

- Next.js 16 App Router — layouts aninhados, Server vs Client Components
- API client com Zod validation — sem `any`, erros tipados
- Zustand para estado de auth + persist no localStorage
- Middleware Next.js para proteção de rotas (redirect se não autenticado)
- Refresh token automático — access token renovado transparentemente
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
│   │   │   ├── events/[slug]/
│   │   │   │   └── page.tsx        # Página do evento (SSR)
│   │   │   └── search/
│   │   │       └── page.tsx        # Resultados de busca
│   │   ├── (buyer)/                # Route group — área do comprador
│   │   │   ├── checkout/
│   │   │   │   ├── page.tsx        # Checkout com Stripe Elements
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

---

## Passo 10.2 — `next.config.ts`

```typescript
// apps/web/next.config.ts

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Turbopack — compilação 400% mais rápida que Webpack
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

  // Experimental: PPR (Partial Pre-Rendering) — combina static + dynamic por componente
  experimental: {
    ppr: true,
  },
};

export default nextConfig;
```

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

import { z, ZodSchema } from 'zod';
import { getAuthStore } from '../store/auth-store';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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

  // Adicionar token de autenticação
  if (!skipAuth) {
    const accessToken = getAuthStore().getState().accessToken;
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
    getAuthStore().getState().logout();
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
  // Se a API retornar um formato inesperado, o erro é capturado aqui
  const result = schema.safeParse(body);
  if (!result.success) {
    console.error('[API] Resposta inválida do servidor:', result.error.errors);
    throw new ApiError(500, 'Resposta inesperada do servidor');
  }

  return result.data;
}

async function tryRefreshToken(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',  // enviar httpOnly cookie
    });

    if (!response.ok) return false;

    const data = await response.json() as { accessToken: string; expiresIn: number };
    getAuthStore().getState().setAccessToken(data.accessToken, data.expiresIn);
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
import { EventResponseSchema, z } from '@showpass/types';

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

export async function getEventBySlug(slug: string) {
  return apiRequest(
    `/events/${slug}/public`,
    EventResponseSchema,
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
// IMPORTANTE: armazenar APENAS o access token no localStorage.
// O refresh token está em httpOnly cookie — JavaScript não consegue lê-lo.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface AuthUser {
  id: string;
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
}

interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  expiresAt: number | null;  // timestamp em ms

  // Actions
  setAccessToken: (token: string, expiresIn: number) => void;
  setUser: (user: AuthUser) => void;
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

      setAccessToken: (token, expiresIn) => {
        set({
          accessToken: token,
          expiresAt: Date.now() + expiresIn * 1000,
        });
      },

      setUser: (user) => set({ user }),

      logout: () => {
        set({ accessToken: null, user: null, expiresAt: null });
        // Chamar endpoint de logout para revogar o refresh token (cookie httpOnly)
        fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
      },

      isAuthenticated: () => {
        const state = get();
        return !!state.accessToken && !state.isTokenExpired();
      },

      isTokenExpired: () => {
        const { expiresAt } = get();
        if (!expiresAt) return true;
        // Considerar expirado 30s antes do tempo real (margem de segurança)
        return Date.now() >= expiresAt - 30_000;
      },
    }),
    {
      name: 'showpass-auth',
      storage: createJSONStorage(() => localStorage),
      // Não persistir dados sensíveis que não precisamos recuperar
      partialize: (state) => ({
        accessToken: state.accessToken,
        user: state.user,
        expiresAt: state.expiresAt,
      }),
    },
  ),
);

// Export da instância para uso fora de componentes (no api-client.ts)
export const getAuthStore = () => useAuthStore;
```

---

## Passo 10.6 — Middleware de Proteção de Rotas

```typescript
// apps/web/src/middleware.ts
//
// Executa no Edge Runtime antes de cada request.
// Redireciona para login se a rota exige autenticação.
// Verifica o access token do cookie (para SSR) ou header.

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
    // Verificar o JWT com a chave pública (Edge Runtime compatível com jose)
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
  const loginPath = type === 'organizer' ? '/login' : '/buyer/login';
  const url = request.nextUrl.clone();
  url.pathname = loginPath;
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
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

## Passo 10.8 — Login Page (Client Component)

```typescript
// apps/web/src/app/(public)/login/page.tsx
'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/store/auth-store';
import { ApiError } from '@/lib/api-client';

// Zod 4: z.email() top-level (z.string().email() é deprecated desde v4)
const LoginSchema = z.object({
  email: z.email('E-mail inválido'),
  password: z.string().min(1, 'Senha obrigatória'),
});

type LoginForm = z.infer<typeof LoginSchema>;

export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setAccessToken, setUser } = useAuthStore();
  const [error, setError] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginForm>({
    resolver: zodResolver(LoginSchema),
  });

  const onSubmit = async (data: LoginForm): Promise<void> => {
    setError(null);

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/buyers/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include',  // receber httpOnly cookie do refresh token
      });

      if (!response.ok) {
        const err = await response.json() as { message: string };
        setError(err.message);
        return;
      }

      const result = await response.json() as { accessToken: string; expiresIn: number; user: any };
      setAccessToken(result.accessToken, result.expiresIn);
      setUser(result.user);

      // Redirecionar para a página original ou para o dashboard
      const redirect = searchParams.get('redirect') ?? '/dashboard';
      router.push(redirect);

    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Erro de conexão. Tente novamente.');
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm p-8 bg-white rounded-2xl shadow-md">
        <h1 className="text-2xl font-bold text-center mb-6">ShowPass</h1>
        <h2 className="text-gray-600 text-center mb-8">Área do Organizador</h2>

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

          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Entrando...' : 'Entrar'}
          </Button>
        </form>
      </div>
    </div>
  );
}
```

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

**2. Acessar a tela de login**

Navegue para: **http://localhost:3001/login**

**3. Fazer login como organizer**

Use as credenciais criadas no Cap 04:

- Email: `admin@rockshows.com.br`
- Senha: `Senha@Forte123`

Após o login, você deve ser redirecionado para o dashboard.

**4. Verificar que o token foi armazenado**

Abra o DevTools do browser (F12) → Application → Cookies.

Você verá o cookie `refresh_token` com flag `httpOnly` — **não acessível via JavaScript** (OWASP A07).

No Zustand (Application → Local Storage), você verá o estado de auth com `accessToken` e dados do usuário.

**5. Verificar proteção de rota**

Faça logout e tente acessar diretamente: **http://localhost:3001/dashboard**

O middleware Edge Runtime deve redirecionar imediatamente para `/login` sem flash de conteúdo.

**6. Verificar auto-refresh do token**

Aguarde 15 minutos com a aba aberta (ou manipule a expiração no DevTools → Application → Local Storage para um timestamp passado). Ao fazer qualquer ação, o Zustand renova o access token automaticamente via `/auth/organizers/refresh` sem fazer logout.

**7. Verificar request para o API Gateway**

No DevTools → Network, filtre por `localhost:3000`. Todas as requests do frontend passam pelo gateway na porta 3000, que adiciona os headers `x-user-id` e `x-organizer-id` antes de fazer proxy para os serviços.

---

## Recapitulando

1. **App Router + PPR** — combina geração estática e dinâmica por componente; melhor performance
2. **API client com Zod** — toda resposta validada em runtime; sem `any` nas fronteiras de rede
3. **Auto-refresh transparente** — access token renovado automaticamente sem relogin
4. **Zustand persist** — estado de auth sobrevive a reload; sem flash de conteúdo não autenticado
5. **Middleware Edge Runtime** — verifica JWT antes de renderizar a página; redirect sem flash
6. **httpOnly cookie** para refresh token — JavaScript nunca acessa o token mais poderoso

---

## Próximo capítulo

[Capítulo 11 → Event Pages & Seat Map](cap-11-event-pages-seat-map.md)
