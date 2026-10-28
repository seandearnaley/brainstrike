/**
 * An open composer popover closes when another thread is selected. Each thread
 * keeps its panel mounted and hides it, so the popover's anchor disappears in
 * the same click: the menu must close and never paint away from its chip, not
 * even for the frames of its exit animation.
 */
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { createTempDirTracker, freshRepo } from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';

const tempDirs = createTempDirTracker();

test.afterAll(() => {
  tempDirs.removeAll();
});

test('selecting another thread closes the open branch menu', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(120_000);
  const repo = freshRepo({ label: 'repo', prefix: 'bst-branch-menu-', tracker: tempDirs });
  await seedRoot(page, repo, {
    disableBackgroundIndexing: true,
    reloadReason: 'branch-menu-thread-switch',
    rootId: 'branch-menu-thread-switch-root-0000-4000-8000-000000000001',
  });
  await configureAssistantProvider(page);
  modelProvider.setScript((request) =>
    JSON.stringify(request.messages).includes('second thread')
      ? { finalText: 'Second reply.' }
      : { finalText: 'First reply.' }
  );
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await input.fill('The first thread.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText('First reply.')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'New thread' }).click();
  await input.fill('The second thread.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText('Second reply.')).toBeVisible({ timeout: 60_000 });

  const menu = page.getByTestId('workspace-bar-branch-menu');
  const rows = page
    .getByRole('treegrid', { name: 'Workspace threads' })
    .getByRole('row', { level: 2 });
  const tabs = page.getByTestId('assistant-thread-tab-strip');

  /**
   * Opens the menu, switches thread, and records every painted frame until the
   * menu is gone: it may fade where it was, but never shows anywhere else.
   */
  async function closesInPlace(switchThread: () => Promise<void>, selected: string) {
    await region.getByTestId('workspace-bar-branch-chip').click();
    await expect(menu).toBeVisible();
    // Past the opening animation, where the menu rests.
    await expect.poll(() => menu.evaluate((element) => element.getAnimations().length)).toBe(0);
    const open = await menu.boundingBox();
    const chip = await region.getByTestId('workspace-bar-branch-chip').boundingBox();
    // Anchored to its chip: the menu starts at the chip's left edge.
    expect(Math.abs((open?.x ?? 0) - (chip?.x ?? Number.NaN))).toBeLessThan(2);
    await page.evaluate(() => {
      const frames: { x: number; y: number }[] = [];
      (window as unknown as { __menuFrames: typeof frames }).__menuFrames = frames;
      const sample = (): void => {
        const element = document.querySelector('[data-testid="workspace-bar-branch-menu"]');
        if (!element) {
          return;
        }
        if (element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
          const { x, y } = element.getBoundingClientRect();
          frames.push({ x, y });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await switchThread();
    await expect(tabs.getByRole('tab', { selected: true })).toContainText(selected);
    await expect(menu).toHaveCount(0);
    const frames = await page.evaluate(
      () => (window as unknown as { __menuFrames: { x: number; y: number }[] }).__menuFrames
    );
    expect(frames.length, 'The menu was painted before the switch').toBeGreaterThan(0);
    for (const frame of frames) {
      expect(Math.abs(frame.x - (open?.x ?? Number.NaN))).toBeLessThan(2);
      expect(Math.abs(frame.y - (open?.y ?? Number.NaN))).toBeLessThan(2);
    }
  }

  await closesInPlace(
    () => rows.filter({ hasText: 'First reply.' }).getByRole('button').first().click(),
    'First reply.'
  );
  await closesInPlace(
    () => tabs.getByRole('tab', { name: /Second reply\./ }).click(),
    'Second reply.'
  );
});
