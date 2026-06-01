// apps/web/e2e/checkout-flow.spec.ts
//
// Playwright testa o fluxo completo no browser (Chromium headless).
// Requer todos os serviços rodando: auth, event, booking, api-gateway, web.
//
// Os `data-testid` usados aqui exigem que os elementos correspondentes
// tenham o atributo adicionado nos componentes (ver abaixo).
// Sem os atributos os seletores funcionam via texto/aria-label como fallback.

import { test, expect } from '@playwright/test';

test.describe('Checkout Flow', () => {
  test('comprador consegue reservar assento e iniciar checkout', async ({ page }) => {
    // Página de login unificada (/login) — criada no cap-10.
    // Chama /auth/buyers/login ou /auth/organizers/login conforme o seletor.
    await page.goto('/login');

    // Seletor de tipo de conta — garantir que "Comprador" está selecionado
    await page.getByRole('button', { name: 'Comprador' }).click();

    // Credenciais de buyer de teste (criadas no cap-11/12 via API)
    // Se não existir, criar previamente com POST /auth/buyers/register
    const email = process.env['PLAYWRIGHT_BUYER_EMAIL'] ?? 'b1780286380854@test.com';
    const password = process.env['PLAYWRIGHT_BUYER_PASSWORD'] ?? 'TestPass123';

    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.getByRole('button', { name: 'Entrar' }).click();

    // Após login bem-sucedido, middleware redireciona para '/'
    await expect(page).toHaveURL('/');

    // Navegar para o evento de teste criado no cap-11
    const eventSlug = process.env['PLAYWRIGHT_EVENT_SLUG'] ?? 'show-teste-cap11-1780286386125';
    await page.goto(`/events/${eventSlug}`);
    await expect(page.locator('h1')).toContainText('Show Teste');

    // Selecionar lote (TicketBatchSelector — botão com o nome do lote)
    const batchButton = page.getByRole('button', { name: 'Pista' }).first();
    await batchButton.click();

    // Selecionar assento disponível (verde) via aria-label
    const availableSeat = page.locator('[aria-label*="Disponível"]').first();
    await availableSeat.click();

    // Verificar optimistic UI — assento muda para selecionado (aria-pressed=true)
    await expect(availableSeat).toHaveAttribute('aria-pressed', 'true');

    // Clicar em Reservar Agora
    await page.getByRole('button', { name: 'Reservar Agora' }).click();

    // Deve redirecionar para /checkout?reservation=<uuid>
    await page.waitForURL(/\/checkout\?reservation=/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/checkout\?reservation=/);

    // Aguardar hidratação do Client Component (timer + resumo)
    await expect(page.getByText('Finalizar Compra')).toBeVisible({ timeout: 10_000 });

    // Timer de reserva visível e no formato MM:SS
    const timerLocator = page.getByText(/\d{2}:\d{2}/).first();
    await expect(timerLocator).toBeVisible({ timeout: 5_000 });
    const timerText = await timerLocator.textContent();
    // TTL = 7 minutos = 420s — espera entre 00:00 e 07:00
    expect(timerText).toMatch(/0[0-7]:[0-5][0-9]/);

    // Botão "Pagar com Stripe" visível e habilitado
    const stripeButton = page.getByRole('button', { name: 'Pagar com Stripe' });
    await expect(stripeButton).toBeVisible();
    await expect(stripeButton).toBeEnabled();
  });

  test('/dashboard sem login redireciona para /login?as=organizer', async ({ page }) => {
    await page.goto('/dashboard');
    // Middleware Edge deve redirecionar
    await expect(page).toHaveURL(/\/login.*as=organizer/);
  });

  test('/checkout sem login redireciona para /login?as=buyer', async ({ page }) => {
    await page.goto('/checkout?reservation=fake-id');
    await expect(page).toHaveURL(/\/login.*as=buyer/);
  });
});
