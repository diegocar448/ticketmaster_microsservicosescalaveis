// apps/web/playwright.config.ts
//
// Configuração Playwright para testes E2E do frontend.
// Requer todos os serviços rodando (auth, event, booking, api-gateway, web).

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,

  use: {
    // URL base do frontend Next.js (porta 3001 por convenção do projeto)
    baseURL: process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3001',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Não sobe o dev server automaticamente — presupõe que `pnpm dev` já rodou
  // (consistente com o padrão de dev do projeto: scripts/dev.sh start)
});
