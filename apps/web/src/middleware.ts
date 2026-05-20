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

  if (!isOrganizerRoute && !isBuyerRoute) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get('authorization');
  const token =
    authHeader?.replace('Bearer ', '') ??
    request.cookies.get('access_token')?.value;

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
    '/dashboard/:path*',
    '/events/create',
    '/events/edit/:path*',
    '/checkout/:path*',
    '/my-tickets/:path*',
  ],
};
