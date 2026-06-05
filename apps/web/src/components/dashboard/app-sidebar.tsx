'use client';

// apps/web/src/components/dashboard/app-sidebar.tsx
//
// Sidebar do painel do organizer (shadcn/ui base-nova), no padrão do template
// next-shadcn-admin-dashboard (MIT): navegação agrupada + footer com o usuário
// (email + Sair). A navegação usa render={<Link/>} (Base UI ≈ asChild do Radix).

import type React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  CalendarPlus,
  Settings,
  LogOut,
  Loader2,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { useAuthStore } from '@/store/auth-store';
import { LoadingOverlay } from '@/components/loading-overlay';

const items = [
  { title: 'Dashboard', url: '/dashboard', icon: LayoutDashboard },
  { title: 'Criar evento', url: '/events/create', icon: CalendarPlus },
  { title: 'Configurações', url: '/dashboard/settings', icon: Settings },
];

export function AppSidebar(): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  // mounted: o auth-store só hidrata no cliente → evita mismatch com o SSR.
  const [mounted, setMounted] = useState(false);
  const [navigating, setNavigating] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const email = mounted ? (user?.email ?? '') : '';
  const initial = email ? email.charAt(0).toUpperCase() : 'O';

  const handleLogout = (): void => {
    if (navigating) return;
    logout();
    setNavigating(true);
    router.push('/');
    router.refresh();
  };

  return (
    <>
      <LoadingOverlay show={navigating} label="Saindo…" />
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link href="/dashboard" className="px-2 py-1.5 text-lg font-bold">
          ShowPass
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Organizador</SidebarGroupLabel>
          <SidebarMenu>
            {items.map((item) => (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton
                  isActive={pathname === item.url}
                  tooltip={item.title}
                  render={<Link href={item.url} />}
                >
                  <item.icon />
                  <span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip={email || 'Organizador'}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
                {initial}
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">
                  {email || 'Organizador'}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  Organizador
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sair"
              onClick={handleLogout}
              disabled={navigating}
            >
              {navigating ? (
                <Loader2 className="animate-spin" />
              ) : (
                <LogOut />
              )}
              <span>Sair</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
    </>
  );
}
