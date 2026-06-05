// apps/web/src/app/(public)/login/page.tsx
//
// Server Component que envolve o LoginForm (client) em <Suspense>.
// Next exige Suspense para páginas com useSearchParams() na geração
// estática — sem isso, `next build` falha (missing-suspense-with-csr-bailout).

import type React from 'react';
import { Suspense } from 'react';
import { FullScreenLoader } from '@/components/loading-overlay';
import { LoginForm } from './login-form';

export default function LoginPage(): React.JSX.Element {
  return (
    <Suspense fallback={<FullScreenLoader label="Carregando…" />}>
      <LoginForm />
    </Suspense>
  );
}
