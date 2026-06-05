// apps/web/src/app/page.tsx
//
// Landing imersiva (estilo "Neural Access"): fundo escuro com nós neurais,
// glow rotativo, logo com anéis animados, título em gradiente.
//
// Server Component — lê o cookie access_token para detectar se o buyer
// já está logado e mostrar CTA diferente (ver eventos vs entrar).

import type React from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { HomeEntrarButton } from '@/components/home-entrar-button';

// Nós neurais (pontos animados no fundo)
const nodes = [
  { top: '14%', left: '12%', size: 3, delay: '0s' },
  { top: '22%', left: '84%', size: 2, delay: '1.1s' },
  { top: '38%', left: '20%', size: 2, delay: '2.2s' },
  { top: '30%', left: '68%', size: 4, delay: '0.6s' },
  { top: '66%', left: '14%', size: 3, delay: '1.7s' },
  { top: '72%', left: '82%', size: 2, delay: '0.3s' },
  { top: '80%', left: '40%', size: 2, delay: '2.6s' },
  { top: '54%', left: '90%', size: 3, delay: '1.4s' },
];

export default async function HomePage(): Promise<React.JSX.Element> {
  // Lê o cookie no servidor para saber se o buyer está logado.
  // O middleware já redireciona organizers para /dashboard — quem chega aqui
  // é: visitante (sem token) ou buyer autenticado.
  const cookieStore = await cookies();
  const token = cookieStore.get('access_token')?.value;

  // Decodificar o payload do JWT sem verificar assinatura (só para saber o tipo).
  // Segurança: a verificação criptográfica já foi feita no middleware Edge.
  if (token) {
    try {
      // split('.')[1] pode ser undefined em token malformado — usar ?? '' como fallback seguro.
      const part = token.split('.')[1] ?? '';
      const payload = JSON.parse(
        Buffer.from(part, 'base64url').toString(),
      ) as { type?: string };

      // Buyer autenticado não precisa ver a landing — redirecionar direto para eventos.
      // O middleware já garante que organizers vão para /dashboard.
      // redirect() lança uma exceção interna do Next — deve ficar dentro do try para
      // não ser engolida pelo catch abaixo.
      if (payload.type === 'buyer') redirect('/events');
    } catch {
      // token malformado ou redirect() — ignorar, mostrar CTA padrão
    }
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#0a0a0f] px-6 text-center">
      {/* Nós neurais */}
      <div className="pointer-events-none absolute inset-0">
        {nodes.map((n) => (
          <span
            key={`${n.top}-${n.left}`}
            className="absolute animate-pulse rounded-full bg-blue-500/60"
            style={{
              top: n.top,
              left: n.left,
              width: n.size,
              height: n.size,
              animationDelay: n.delay,
            }}
          />
        ))}
      </div>

      {/* Glow rotativo central */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[700px] w-[700px] -translate-x-1/2 -translate-y-1/2 animate-[neural-glow_8s_linear_infinite] rounded-full bg-[radial-gradient(circle,rgba(99,102,241,0.18),rgba(139,92,246,0.06)_45%,transparent_70%)] blur-2xl" />

      {/* Vinheta sutil nas bordas */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.6))]" />

      <div className="relative z-10 flex flex-col items-center gap-7">
        {/* Logo com anéis pulsantes + núcleo girando */}
        <div className="relative size-24">
          <span className="absolute inset-0 animate-ping rounded-full border border-blue-500/30" />
          <span className="absolute inset-[8px] animate-ping rounded-full border border-violet-500/30 [animation-delay:0.7s]" />
          <span className="absolute inset-0 flex items-center justify-center rounded-full border border-blue-500/20 bg-blue-500/5 shadow-[0_0_40px_rgba(99,102,241,0.35)]">
            <Sparkles className="size-9 animate-[spin_8s_linear_infinite] text-blue-400" />
          </span>
        </div>

        <h1 className="bg-linear-to-br from-white via-blue-200 to-violet-300 bg-clip-text text-5xl font-bold tracking-tight text-transparent sm:text-7xl">
          ShowPass
        </h1>

        <p className="max-w-md text-base text-slate-400 sm:text-lg">
          Ingressos para shows, teatro, esportes e muito mais.
        </p>

        {/* Visitante (buyer seria redirecionado antes de chegar aqui) */}
        <HomeEntrarButton />
      </div>
    </main>
  );
}
