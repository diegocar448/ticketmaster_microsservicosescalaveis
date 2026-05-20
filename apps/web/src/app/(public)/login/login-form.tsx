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

      // setAuth decodifica o JWT e popula `user` a partir dos claims
      setAuth(parsed.data.accessToken, parsed.data.expiresIn);

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
