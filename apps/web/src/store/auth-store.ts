// apps/web/src/store/auth-store.ts
//
// Estado de auth com persist no localStorage. Guardamos APENAS o access
// token; o refresh token vive em httpOnly cookie (JS nunca o lê).
//
// Decodificar ≠ verificar: jwt-decode só lê o payload base64 para popular a
// UI. A verificação de assinatura ocorre no middleware (Edge/jose) e no
// API Gateway — nunca confie nos claims para segurança no cliente.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { jwtDecode } from 'jwt-decode';

interface AuthUser {
  id: string; // claim "sub"
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
}

interface JwtClaims {
  sub: string;
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;
  exp: number;
}

interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  expiresAt: number | null; // timestamp em ms

  setAuth: (token: string, expiresIn: number) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
  isTokenExpired: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      user: null,
      expiresAt: null,

      // Recebe o token bruto, decodifica os claims e popula `user`.
      setAuth: (token, expiresIn): void => {
        const claims = jwtDecode<JwtClaims>(token);
        set({
          accessToken: token,
          expiresAt: Date.now() + expiresIn * 1000,
          user: {
            id: claims.sub,
            email: claims.email,
            type: claims.type,
            ...(claims.organizerId !== undefined
              ? { organizerId: claims.organizerId }
              : {}),
          },
        });
      },

      logout: (): void => {
        // Capturar token e tipo ANTES de apagar o estado — o fetch de revogação
        // precisa do Bearer token (gateway injeta x-user-id/x-user-type a partir
        // dele). Se apagar primeiro, o gateway recebe a request sem JWT → 401.
        const { accessToken, user } = get();
        const userType = user?.type;

        set({ accessToken: null, user: null, expiresAt: null });

        // Expira o cookie access_token (espelho do token p/ middleware/SSR).
        // `typeof document` evita ReferenceError se chamado no SSR.
        if (typeof document !== 'undefined') {
          document.cookie = 'access_token=; path=/; max-age=0; SameSite=Lax';
        }

        // Revoga o refresh token no servidor (cookie httpOnly).
        // Rota de logout depende do tipo: organizer usa /auth/logout,
        // buyer usa /auth/buyers/logout (guard diferente).
        if (!accessToken) return;

        const gatewayUrl = process.env['NEXT_PUBLIC_API_URL'];
        const route =
          userType === 'organizer' ? '/auth/logout' : '/auth/buyers/logout';

        void fetch(`${gatewayUrl}${route}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            // Gateway precisa do Bearer para injetar x-user-id/x-user-type
            // nos headers internos, que os guards do auth-service leem.
            Authorization: `Bearer ${accessToken}`,
          },
        }).catch(() => undefined);
      },

      isAuthenticated: (): boolean => {
        const state = get();
        return !!state.accessToken && !state.isTokenExpired();
      },

      isTokenExpired: (): boolean => {
        const { expiresAt } = get();
        if (!expiresAt) return true;
        // Margem de 30s para latência de rede
        return Date.now() >= expiresAt - 30_000;
      },
    }),
    {
      name: 'showpass-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        accessToken: state.accessToken,
        user: state.user,
        expiresAt: state.expiresAt,
      }),
    },
  ),
);
