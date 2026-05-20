// apps/web/src/env.d.ts
//
// Tipa process.env como propriedades DECLARADAS (não index signature).
// Sem isto, `process.env.NEXT_PUBLIC_API_URL` (notação ponto, EXIGIDA pelo
// Next para substituição estática de NEXT_PUBLIC_*) dispara TS4111 sob
// `noPropertyAccessFromIndexSignature` do tsconfig base.

declare namespace NodeJS {
  interface ProcessEnv {
    readonly NEXT_PUBLIC_API_URL: string;
    readonly NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: string;
    readonly JWT_PUBLIC_KEY: string;
    readonly NODE_ENV: 'development' | 'production' | 'test';
  }
}
