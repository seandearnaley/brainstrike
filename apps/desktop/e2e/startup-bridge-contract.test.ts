import { expect, test } from './fixtures/electron-fixture';

test.describe.configure({ mode: 'serial' });

test.describe('Desktop startup bridge contract', () => {
  test('fails fast with a startup contract error when critical preload bridges are missing', async ({
    electronHarness,
  }) => {
    process.env['BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES'] = 'electronAPI,logging';

    try {
      const { window } = await electronHarness.restart();
      const failure = window.getByTestId('desktop-startup-failure');
      await expect(failure).toBeVisible({ timeout: 30_000 });
      await expect(failure).toContainText(/desktop preload bridge is incomplete/i);
      await expect(failure).toContainText(/preload script did not initialize correctly/i);
      await expect(failure).toContainText(/check the electron startup logs/i);
      await expect(failure).toContainText(/window\.electronAPI/i);
      await expect(failure).toContainText(/window\.logging/i);
    } finally {
      process.env['BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES'] = undefined;
      await electronHarness.restart();
    }
  });
});
