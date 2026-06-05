// apps/web/src/app/(public)/login/login-form.tsx
//
// Componente client do login UNIFICADO. Usa useSearchParams() — por isso
// vive separado da page (que o envolve em <Suspense>: requisito do Next
// para static generation de páginas com useSearchParams).
//
// Visual "Neural Access" (glassmorphism dark) inspirado no template MIT
// puikinsh/login-forms (forms/ai-assistant). A tela de login é sempre escura,
// independente do tema do app — é uma tela de marca imersiva.
'use client';

import type React from 'react';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, Sparkles, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { LoadingOverlay } from '@/components/loading-overlay';
import { LoginRequestSchema, LoginResponseSchema } from '@showpass/types';
import { ApiError } from '@/lib/api-client';

// Reutiliza o schema do @showpass/types — mesma fonte da verdade do backend.
type LoginFormValues = z.infer<typeof LoginRequestSchema>;
type LoginAs = 'organizer' | 'buyer';

// Posições/atrasos dos "nós neurais" (pontos animados no fundo).
const nodes = [
  { top: '18%', left: '14%', delay: '0s' },
  { top: '24%', left: '82%', delay: '1.2s' },
  { top: '70%', left: '10%', delay: '0.6s' },
  { top: '78%', left: '88%', delay: '1.8s' },
  { top: '45%', left: '92%', delay: '2.4s' },
];

const inputClass =
  'w-full rounded-xl border border-blue-500/20 bg-slate-800/50 px-4 py-3.5 text-sm text-slate-50 placeholder:text-slate-500 outline-none transition focus:border-blue-500 focus:bg-slate-800/80 focus:ring-1 focus:ring-blue-500/50';

export function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // navigating: true após auth bem-sucedida e router.push() disparado.
  // Mantém o overlay visível durante a transição de rota (do push até o
  // componente desmontar quando o destino carregar). O react-hook-form zera
  // isSubmitting assim que o handler retorna — mas o dashboard ainda não
  // carregou. navigating fecha esse gap.
  const [navigating, setNavigating] = useState(false);

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

      // Também grava o access token num cookie NÃO-httpOnly (middleware Edge e
      // Server Components leem o cookie; o localStorage não é visível a eles).
      document.cookie = `access_token=${parsed.data.accessToken}; path=/; max-age=${String(parsed.data.expiresIn)}; SameSite=Lax`;

      // Organizer → painel admin; buyer → home (landing com eventos públicos).
      const fallback = loginAs === 'organizer' ? '/dashboard' : '/';
      // Ativa o overlay de "navegando" ANTES do push para não haver gap entre
      // isSubmitting virar false e o app/loading.tsx do Next assumir.
      setNavigating(true);
      router.push(searchParams.get('redirect') ?? fallback);
      // Não chamar return aqui — o componente desmonta quando o destino carrega,
      // levando o overlay com ele. navigating nunca volta a false neste fluxo.
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Erro de conexão. Tente novamente.',
      );
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0a0a0f] p-5">
      {/* Overlay contínuo: isSubmitting cobre a req de auth; navigating cobre
          a transição de rota até o destino (dashboard/home) carregar. */}
      <LoadingOverlay show={isSubmitting || navigating} label="Entrando…" />

      {/* Nós neurais — pontos azuis pulsantes no fundo */}
      <div className="pointer-events-none absolute inset-0">
        {nodes.map((n) => (
          <span
            key={`${n.top}-${n.left}`}
            className="absolute size-[3px] animate-pulse rounded-full bg-blue-500/60"
            style={{ top: n.top, left: n.left, animationDelay: n.delay }}
          />
        ))}
      </div>

      {/* Card glass */}
      <div className="relative w-full max-w-md overflow-hidden rounded-[20px] border border-blue-500/20 bg-[rgba(15,15,20,0.95)] px-8 py-10 backdrop-blur-xl">
        {/* Glow radial rotativo */}
        <div className="pointer-events-none absolute -top-1/2 -left-1/2 h-[200%] w-[200%] animate-[neural-glow_6s_linear_infinite] bg-[radial-gradient(circle,rgba(59,130,246,0.12),transparent_60%)]" />

        <div className="relative">
          {/* Logo com anéis pulsantes + núcleo girando */}
          <div className="relative mx-auto mb-6 size-20">
            <span className="absolute inset-0 animate-ping rounded-full border border-blue-500/30" />
            <span className="absolute inset-[6px] animate-ping rounded-full border border-blue-500/30 [animation-delay:0.6s]" />
            <span className="absolute inset-0 flex items-center justify-center rounded-full border border-blue-500/20 bg-blue-500/5">
              <Sparkles className="size-7 animate-[spin_8s_linear_infinite] text-blue-500" />
            </span>
          </div>

          <h1 className="text-center text-2xl font-bold tracking-tight text-slate-50">
            ShowPass
          </h1>
          <p className="mt-1 text-center text-sm text-slate-400">
            Acesse sua conta
          </p>

          {/* Abas Comprador / Organizador */}
          <div className="mt-6 grid grid-cols-2 gap-1 rounded-xl border border-blue-500/15 bg-slate-800/40 p-1">
            {(['buyer', 'organizer'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setLoginAs(t);
                }}
                className={
                  'rounded-lg py-2 text-sm transition ' +
                  (loginAs === t
                    ? 'bg-blue-500/20 font-medium text-slate-50'
                    : 'text-slate-400 hover:text-slate-200')
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
            className="mt-5 space-y-4"
          >
            {/* Email */}
            <div>
              <div className="relative">
                <input
                  type="email"
                  placeholder="Email"
                  {...register('email')}
                  aria-invalid={!!errors.email}
                  // Extensões (Kaspersky, gerenciadores de senha) injetam atributos
                  // no input antes do React hidratar → mismatch. Suprimir é o fix
                  // recomendado pelo React: afeta só os atributos deste elemento.
                  suppressHydrationWarning
                  className={`${inputClass} pr-10`}
                />
                <span className="absolute top-1/2 right-3 size-2 -translate-y-1/2 animate-pulse rounded-full bg-blue-500" />
              </div>
              {errors.email ? (
                <p className="mt-1 text-sm text-red-400">
                  {errors.email.message}
                </p>
              ) : null}
            </div>

            {/* Senha com toggle de visibilidade */}
            <div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Senha"
                  {...register('password')}
                  aria-invalid={!!errors.password}
                  suppressHydrationWarning
                  className={`${inputClass} pr-16`}
                />
                <button
                  type="button"
                  onClick={() => {
                    setShowPassword((v) => !v);
                  }}
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  className="absolute top-1/2 right-9 -translate-y-1/2 text-slate-400 transition hover:text-slate-200"
                >
                  {showPassword ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
                <span className="absolute top-1/2 right-3 size-2 -translate-y-1/2 animate-pulse rounded-full bg-blue-500" />
              </div>
              {errors.password ? (
                <p className="mt-1 text-sm text-red-400">
                  {errors.password.message}
                </p>
              ) : null}
            </div>

            {error ? (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-center text-sm text-red-400">
                {error}
              </p>
            ) : null}

            {/* Botão gradiente "neural" */}
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-br from-blue-500 to-violet-500 py-3.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition hover:from-blue-600 hover:to-violet-600 active:scale-[0.98] disabled:opacity-60"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Entrando…
                </>
              ) : (
                'Entrar'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
