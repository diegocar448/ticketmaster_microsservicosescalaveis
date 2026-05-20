// apps/web/src/lib/api-client.ts
//
// Cliente HTTP centralizado: validação Zod da resposta, auto-refresh do
// access token em 401, erro tipado. useAuthStore.getState() é o padrão
// idiomático Zustand fora de componentes React.

import type { ZodType } from 'zod';
import { RefreshResponseSchema } from '@showpass/types';
import { useAuthStore } from '../store/auth-store';

// API Gateway na :3000; o frontend Next.js na :3001.
// NEXT_PUBLIC_API_URL é declarada (env.d.ts) e obrigatória — o default de
// dev mora no apps/web/.env, não no código (evita no-unnecessary-condition).
const BASE_URL = process.env.NEXT_PUBLIC_API_URL;

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

export async function apiRequest<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const { skipAuth = false, ...fetchOptions } = options;

  const headers = new Headers(fetchOptions.headers);
  headers.set('Content-Type', 'application/json');

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

  // 401 → tentar refresh transparente, retry com o novo token
  if (response.status === 401 && !skipAuth) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      return apiRequest(path, schema, options);
    }
    useAuthStore.getState().logout();
    throw new ApiError(401, 'Sessão expirada. Faça login novamente.');
  }

  let body: unknown;
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  if (!response.ok) {
    const err = body as {
      message?: string;
      errors?: Array<{ field: string; message: string }>;
    };
    throw new ApiError(
      response.status,
      err.message ?? `HTTP ${String(response.status)}`,
      err.errors,
      response.headers.get('x-request-id') ?? undefined,
    );
  }

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
      credentials: 'include', // envia o httpOnly cookie do refresh token
    });

    const data: unknown = await response.json();

    // Distingue resposta de sucesso de resposta de erro ({statusCode,message})
    const parsed = RefreshResponseSchema.safeParse(data);
    if (!parsed.success) return false;
    if (!('accessToken' in parsed.data)) return false;

    useAuthStore
      .getState()
      .setAuth(parsed.data.accessToken, parsed.data.expiresIn);
    return true;
  } catch {
    return false;
  }
}
