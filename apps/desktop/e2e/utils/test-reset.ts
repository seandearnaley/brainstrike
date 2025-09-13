import type { Page } from 'playwright';

// Reset helper to reduce cross-test state when using boot-once fixture
export async function resetToAppHome(window: Page): Promise<void> {
  // Try to close any dialogs
  const dialog = window.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false)) {
    const closeBtn = dialog.getByRole('button', { name: /close|ok|dismiss|cancel/i }).first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click().catch(() => {});
    }
  }

  // Ensure main app root is visible
  const root = window.locator('#root');
  await root.waitFor({ state: 'attached' });
}
