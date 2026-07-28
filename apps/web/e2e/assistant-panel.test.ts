import { expect, test } from '@playwright/test';
import { mockAssistantApi } from './utils/assistant-mocks';
import { openAssistantWorkspace } from './utils/assistant-workspace';

test.describe('Assistant panel (assistant-ui default) @stateful @web-assistant-state', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    const response = await request.get('/api/assistant/status');
    const payload = (await response.json()) as { enabled?: boolean };
    if (!payload.enabled) {
      testInfo.skip(true, 'Assistant disabled (missing API key)');
    }
  });

  test.beforeEach(async ({ page }) => {
    await mockAssistantApi(page);
    await openAssistantWorkspace(page, { rootName: 'assistant-panel' });
  });

  test('send message and stream response while switching agent sidebar tabs', async ({ page }) => {
    const viewport = page.getByTestId('assistant-ui-viewport');
    await expect(viewport).toBeVisible();

    await page.locator('#assistant-input').fill('hello world');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(viewport.getByText(/Mock response from tests/i).first()).toBeVisible({
      timeout: 10_000,
    });

    const databaseTab = page.getByRole('tab', { name: 'Collections' });
    await databaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });

    const threadsTab = page.getByRole('tab', { name: 'Threads' });
    await threadsTab.click();
    await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 15_000 });

    await expect(viewport.getByText(/Mock response from tests/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe('Hosted Web multi-provider picker @stateful @web-assistant-state', () => {
  test('shows both server-configured providers without exposing credentials', async ({ page }) => {
    await mockAssistantApi(page, {
      enabled: true,
      model: 'gpt-5.6-terra',
      provider: 'openai',
      providerKeySources: [
        { envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' },
        { envVar: 'ANTHROPIC_API_KEY', provider: 'anthropic', source: 'env' },
      ],
      providers: ['openai', 'anthropic'],
    });
    await openAssistantWorkspace(page, { rootName: 'assistant-multi-provider' });

    const status = await page.evaluate(async () => {
      const response = await fetch('/api/assistant/status');
      return (await response.json()) as Record<string, unknown>;
    });
    expect(status).toEqual({
      enabled: true,
      model: 'gpt-5.6-terra',
      provider: 'openai',
      providerKeySources: [
        { envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' },
        { envVar: 'ANTHROPIC_API_KEY', provider: 'anthropic', source: 'env' },
      ],
      providers: ['openai', 'anthropic'],
    });
    expect(JSON.stringify(status)).not.toContain('apiKey');

    const trigger = page.getByTestId('composer-model-menu-trigger');
    await expect(trigger).toHaveAccessibleName(/GPT-5\.6 Terra/);
    await expect(
      page.getByText(
        'Assistant memory for hosted providers requires the desktop assistant backend.'
      )
    ).toBeVisible();
    await expect(trigger).toBeDisabled();
  });
});
