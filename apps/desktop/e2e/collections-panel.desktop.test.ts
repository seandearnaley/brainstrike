import { expect, test } from './fixtures/electron-fixture';
import { showDatabaseDemoPanel } from './utils/layout-helpers';

test.describe('Collections panel', () => {
  test('shows a newly created collection immediately without leaving the Collections tab', async ({
    window,
  }) => {
    test.setTimeout(180_000);
    const activeWindow = await showDatabaseDemoPanel(window);
    const panel = activeWindow.getByTestId('database-demo-panel');

    const collectionName = `Immediate Collection ${Date.now()}`;
    await panel.getByRole('button', { name: 'New' }).click({ timeout: 15_000 });
    const dialog = activeWindow.getByRole('dialog');
    await expect(dialog.getByText('Create Search Collection')).toBeVisible({ timeout: 15_000 });
    await dialog.getByLabel('Name *').fill(collectionName);
    await dialog.getByRole('button', { name: 'Create Collection' }).click({ timeout: 15_000 });
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const createdOption = activeWindow.getByRole('option', { name: new RegExp(collectionName) });
    await expect(createdOption).toBeVisible({ timeout: 15_000 });
    await expect(createdOption).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toBeVisible();
  });
});
