// apps/web/src/lib/api-server.ts
//
// Variante server-only do api-client. Server Components e Route Handlers NÃO
// têm acesso ao Zustand (que vive no localStorage do browser) — o token é lido
// do cookie `access_token` (gravado no login) via next/headers cookies().
//
// `import 'server-only'` garante erro de build se um Client Component importar
// este módulo por engano (cookies() não existe no cliente).
import 'server-only';

import { cookies } from 'next/headers';
import type { ZodType } from 'zod';
import { apiRequest } from './api-client';

export async function apiRequestServer<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestInit = {},
): Promise<T> {
  const cookieStore = await cookies();
  const token = cookieStore.get('access_token')?.value;

  // new Headers() normaliza HeadersInit (objeto | array | Headers) sem spread.
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  // skipAuth evita o lookup do Zustand (sempre null no servidor); passamos o
  // Authorization explicitamente a partir do cookie. Sem refresh server-side —
  // o middleware Edge já barra tokens expirados antes de chegar aqui.
  return apiRequest(path, schema, { ...options, skipAuth: true, headers });
}
