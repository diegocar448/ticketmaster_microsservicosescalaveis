// apps/web/src/components/ui/toaster.tsx
//
// Placeholder do Toaster global (montado no root layout). Capítulos
// seguintes ligam um provider real (sonner/shadcn). Por ora, só o slot.

import type React from 'react';

export function Toaster(): React.JSX.Element {
  return <div id="toaster-root" aria-live="polite" />;
}
