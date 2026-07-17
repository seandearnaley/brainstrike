import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

test.describe('Agent sidebar database access @stateful @web-db-startup', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
  });

  test('keeps the database tab available across sidebar hide/show and reload', async ({ page }) => {
    const elements = getPanelElements(page);

    await page.waitForSelector(
      '[data-testid="show-threads-panel"], [data-testid="hide-threads-panel"]',
      {
        state: 'attached',
      }
    );

    const showSidebar = await elements.showAgentPanelShim.isVisible().catch(() => false);
    const hideSidebar = await elements.hideAgentPanelButton.isVisible().catch(() => false);
    if (!(showSidebar || hideSidebar)) {
      test.skip(true, 'Agent sidebar controls not available in this environment');
    }

    if (showSidebar) {
      await elements.showAgentPanelShim.click();
    }
    await expect(elements.hideAgentPanelButton).toBeVisible();

    const databaseTab = page.getByRole('tab', { name: 'Collections' });
    await expect(databaseTab).toBeVisible();

    await databaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });

    await elements.hideAgentPanelButton.click();
    await expect(elements.showAgentPanelShim).toBeVisible();
    await elements.showAgentPanelShim.click();
    await expect(elements.hideAgentPanelButton).toBeVisible();

    await databaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await waitForAppLoad(page);

    const reloadedElements = getPanelElements(page);
    if (await reloadedElements.showAgentPanelShim.isVisible().catch(() => false)) {
      await reloadedElements.showAgentPanelShim.click();
    }
    await expect(reloadedElements.hideAgentPanelButton).toBeVisible();

    const reloadedDatabaseTab = page.getByRole('tab', { name: 'Collections' });
    await expect(reloadedDatabaseTab).toBeVisible();
    await reloadedDatabaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
  });

  test('keeps one stable database frame and contains centered actions at the Library minimum', async ({
    page,
  }) => {
    const probe = await page.evaluateHandle(() => {
      const data = {
        directCardSeen: false,
        frameReplaced: false,
        missingAfterMount: 0,
        samples: [] as Array<{
          frame: { height: number; width: number; x: number; y: number };
          toolbarHeight: number | null;
        }>,
      };
      let firstFrame: Element | null = null;
      let mounted = false;
      let running = true;

      const sample = () => {
        const frame = document.querySelector('[data-testid="database-tab-frame"]');
        if (frame) {
          mounted = true;
          firstFrame ??= frame;
          data.frameReplaced ||= firstFrame !== frame;
          data.directCardSeen ||= Boolean(frame.querySelector(':scope > [data-slot="card"]'));
          const toolbar = frame.querySelector(
            '[data-testid="database-tab-loading-toolbar"], [data-testid="database-panel-toolbar"]'
          );
          const frameRect = frame.getBoundingClientRect();
          data.samples.push({
            frame: {
              height: frameRect.height,
              width: frameRect.width,
              x: frameRect.x,
              y: frameRect.y,
            },
            toolbarHeight: toolbar?.getBoundingClientRect().height ?? null,
          });
        } else if (mounted) {
          data.missingAfterMount += 1;
        }
        if (running) {
          requestAnimationFrame(sample);
        }
      };
      requestAnimationFrame(sample);

      return {
        stop: () => {
          running = false;
          return data;
        },
      };
    });

    await page.getByRole('tab', { name: 'Collections' }).click();
    await expect(
      page.locator('[data-testid="database-demo-panel"][aria-busy="false"]')
    ).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.evaluate(() => new Promise(requestAnimationFrame));

    const visualData = await probe.evaluate((value) => value.stop());
    expect(visualData.samples.length).toBeGreaterThan(0);
    expect(visualData.directCardSeen).toBe(false);
    expect(visualData.frameReplaced).toBe(false);
    expect(visualData.missingAfterMount).toBe(0);

    const firstSample = visualData.samples[0];
    if (!firstSample) {
      throw new Error('Database visual probe did not capture a frame');
    }
    for (const sample of visualData.samples) {
      expect(Math.abs(sample.frame.x - firstSample.frame.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.frame.y - firstSample.frame.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.frame.width - firstSample.frame.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.frame.height - firstSample.frame.height)).toBeLessThanOrEqual(1);
      expect(sample.toolbarHeight).toBeGreaterThanOrEqual(47.5);
      expect(sample.toolbarHeight).toBeLessThanOrEqual(48.5);
    }

    const libraryPanel = page.locator('#agent-workspace-explorer-panel');
    const libraryResizeHandle = page.getByRole('separator', { name: 'Resize Library panel' });
    const handleBox = await libraryResizeHandle.boundingBox();
    if (!handleBox) {
      throw new Error('Library resize handle has no geometry');
    }
    const libraryGroupLeft = await libraryPanel.evaluate((panel) => {
      const group = panel.closest('[data-group]');
      if (!group) {
        throw new Error('Library panel group is missing');
      }
      return group.getBoundingClientRect().left;
    });
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(libraryGroupLeft + 140, handleBox.y + handleBox.height / 2, {
      steps: 20,
    });
    await page.mouse.up();

    const libraryWidth = await libraryPanel.evaluate(
      (panel) => panel.getBoundingClientRect().width
    );
    expect(libraryWidth).toBeGreaterThanOrEqual(179);
    expect(libraryWidth).toBeLessThanOrEqual(181);

    const actions = page.getByTestId('database-panel-actions');
    const actionGeometry = await actions.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const buttonRects = Array.from(element.querySelectorAll('button'))
        .map((button) => button.getBoundingClientRect())
        .sort((left, right) => left.left - right.left);
      return {
        buttons: buttonRects.map((buttonRect) => ({
          left: buttonRect.left,
          right: buttonRect.right,
        })),
        clientWidth: element.clientWidth,
        left: rect.left,
        right: rect.right,
        scrollWidth: element.scrollWidth,
      };
    });
    expect(actionGeometry.scrollWidth).toBeLessThanOrEqual(actionGeometry.clientWidth + 1);
    for (const button of actionGeometry.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(actionGeometry.left - 0.5);
      expect(button.right).toBeLessThanOrEqual(actionGeometry.right + 0.5);
    }
    for (let index = 1; index < actionGeometry.buttons.length; index += 1) {
      expect(actionGeometry.buttons[index]?.left ?? 0).toBeGreaterThanOrEqual(
        (actionGeometry.buttons[index - 1]?.right ?? 0) - 0.5
      );
    }
    const actionUnionLeft = Math.min(...actionGeometry.buttons.map((button) => button.left));
    const actionUnionRight = Math.max(...actionGeometry.buttons.map((button) => button.right));
    expect(
      Math.abs(
        (actionUnionLeft + actionUnionRight) / 2 - (actionGeometry.left + actionGeometry.right) / 2
      )
    ).toBeLessThanOrEqual(1);
  });
});
