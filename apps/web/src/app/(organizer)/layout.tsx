// apps/web/src/app/(organizer)/layout.tsx
//
// Shell do painel do organizer: sidebar (shadcn/ui) + área de conteúdo.
// O Header global some nas rotas do organizer (ver components/header.tsx) —
// aqui a navegação é a sidebar.

import type React from 'react';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/dashboard/app-sidebar';
import { ThemeToggle } from '@/components/theme-toggle';
import { LogoutButton } from '@/components/dashboard/logout-button';

export default function OrganizerLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <span className="text-sm font-medium">Painel do Organizador</span>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <LogoutButton />
          </div>
        </header>
        <div className="p-4 sm:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
