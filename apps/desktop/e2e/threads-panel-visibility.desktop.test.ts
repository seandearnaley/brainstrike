import { expect, test } from './fixtures/electron-fixture';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

test('keeps Threads at the top after Settings ribbon round trips', async ({ window: page }) => {
  await ensureAssistantShellVisible(page);
  await page.getByTestId('threads-tab-trigger').click();
  const panel = page.getByTestId('threads-panel');
  await expect(panel.getByTestId('thread-row')).toHaveCount(1);
  for (let index = 0; index < 14; index++) {
    await panel.getByRole('button', { exact: true, name: 'New thread' }).click();
  }
  const viewport = panel.getByTestId('tree-table-viewport');
  const geometry = () =>
    viewport.evaluate((element) => {
      const first = element.querySelector('tr[data-node-id]');
      if (!first) {
        throw new Error('Threads viewport has no rendered thread rows');
      }
      return {
        firstId: first.getAttribute('data-node-id'),
        firstIndex: first.getAttribute('data-index'),
        offset: first.getBoundingClientRect().top - element.getBoundingClientRect().top,
        scrollTop: element.scrollTop,
      };
    });
  await expect.poll(async () => (await geometry()).firstIndex).toBe('0');
  const before = await geometry();
  expect(before.offset).toBe(4);
  expect(before.scrollTop).toBe(0);

  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole('button', { exact: true, name: 'Settings' }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('settings-route')).toBeVisible();
    // Allow hidden-size ResizeObserver delivery before returning to Explorer.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })
    );
    await page.getByRole('button', { exact: true, name: 'Context Explorer' }).click();
    await expect(panel).toBeVisible();
    // Assert the settled geometry, not the pre-observer DOM from the first frame.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })
    );
    await expect.poll(geometry).toEqual(before);
  }
});
