// apps/web/src/app/(buyer)/checkout/page.tsx
//
// Server Component que envolve o CheckoutForm (client) em <Suspense>.
// useSearchParams() exige Suspense para static generation — mesma restrição
// que aplicamos em /login no cap-10.

import type React from 'react';
import { Suspense } from 'react';
import { CheckoutForm } from './checkout-form';

export default function CheckoutPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
        </div>
      }
    >
      <CheckoutForm />
    </Suspense>
  );
}
