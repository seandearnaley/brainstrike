import { expect, test } from './fixtures/electron-fixture';

test.describe('Agent DevTools endpoint', { tag: '@smoke' }, () => {
  test.skip(process.env['BRAINSTRIKE_E2E_AGENT_DEVTOOLS'] !== '1', 'Agent DevTools is opt-in.');

  test('is available only when the opt-in debug env is enabled', async ({ electronApp }) => {
    const response = await fetch('http://127.0.0.1:9222/json/list');
    expect(response.ok).toBe(true);
    const targets = (await response.json()) as Array<{
      readonly type?: string;
      readonly url?: string;
    }>;
    expect(targets.some((target) => target.type === 'page' && Boolean(target.url))).toBe(true);
    await expect(electronApp.window).toHaveTitle(/BrainStrike/i);
  });
});
