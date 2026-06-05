// apps/web/src/middleware.ts
//
// Edge Runtime: roda antes da renderização → redirect sem flash de conteúdo
// protegido. JWT_PUBLIC_KEY vem de apps/web/.env.local (o Edge não herda
// segredos do backend; a chave pública não é segredo).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify, importSPKI } from 'jose';

const ORGANIZER_ROUTES = ['/dashboard', '/events/create', '/events/edit'];
const BUYER_ROUTES = ['/checkout', '/my-tickets'];

// Rotas públicas que usuários AUTENTICADOS não devem ver (home e login).
// Se chegarem aqui com token válido → redirect para o painel adequado.
const AUTH_REDIRECT_ROUTES = ['/', '/login'];

function redirectToLogin(
  request: NextRequest,
  type: 'organizer' | 'buyer',
): NextResponse {
  // Login UNIFICADO em /login (seletor organizer|comprador). `as`
  // pré-seleciona a aba; `redirect` volta à rota original após autenticar.
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('as', type);
  url.searchParams.set('redirect', request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export async function middleware(
  request: NextRequest,
): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  const isOrganizerRoute = ORGANIZER_ROUTES.some((r) => pathname.startsWith(r));
  const isBuyerRoute = BUYER_ROUTES.some((r) => pathname.startsWith(r));
  const isAuthRedirectRoute = AUTH_REDIRECT_ROUTES.includes(pathname);

  // Rota sem restrição: deixar passar
  if (!isOrganizerRoute && !isBuyerRoute && !isAuthRedirectRoute) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get('authorization');
  const token =
    authHeader?.replace('Bearer ', '') ??
    request.cookies.get('access_token')?.value;

  // ── Rotas públicas (/ e /login) com token ─────────────────────────────────
  // Usuário já autenticado: redirecionar para o painel adequado ao invés de
  // mostrar a home/login de novo.
  if (isAuthRedirectRoute) {
    if (!token) return NextResponse.next();

    try {
      const publicKeyPem = process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
      const publicKey = await importSPKI(publicKeyPem, 'RS256');
      const { payload } = await jwtVerify(token, publicKey, {
        audience: 'showpass-api',
        issuer: 'showpass-auth',
      });

      const dest = request.nextUrl.clone();
      // Organizer → /dashboard  |  buyer → / (landing com eventos públicos)
      // Ambos já estão logados — não precisam ver o formulário de login de novo.
      if (payload['type'] === 'organizer') {
        dest.pathname = '/dashboard';
        return NextResponse.redirect(dest);
      }
      // Buyer logado tentando acessar /login → home (já está autenticado)
      // Buyer logado tentando acessar / → deixar passar (é a própria home)
      if (pathname === '/login') {
        dest.pathname = '/';
        return NextResponse.redirect(dest);
      }
      return NextResponse.next();
    } catch {
      // Token inválido/expirado: deixar ver a rota pública normalmente
      return NextResponse.next();
    }
  }

  // ── Rotas protegidas sem token ─────────────────────────────────────────────
  if (!token) {
    return redirectToLogin(request, isOrganizerRoute ? 'organizer' : 'buyer');
  }

  try {
    // env.d.ts tipa JWT_PUBLIC_KEY como string — sem non-null assertion
    const publicKeyPem = process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
    const publicKey = await importSPKI(publicKeyPem, 'RS256');

    const { payload } = await jwtVerify(token, publicKey, {
      audience: 'showpass-api',
      issuer: 'showpass-auth',
    });

    const userType = payload['type'] as string;

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

export const config = {
  matcher: [
    // Rotas públicas que redirecionam para /dashboard quando logado como organizer
    '/',
    '/login',
    // Rotas protegidas
    '/dashboard/:path*',
    '/events/create',
    '/events/edit/:path*',
    '/checkout/:path*',
    '/my-tickets/:path*',
  ],
};
