import { expect, test } from '@playwright/test';
import { openAssistantWorkspace } from './utils/assistant-workspace';
import { getPanelElements } from './utils/layout-helpers';

/**
 * Painted geometry of the assistant thread strip on the BUILT app (BST-1838,
 * spec §5): the shared TabStrip tokens as they actually render, with real
 * Tailwind, fonts and layout — not the class names the unit suites can see.
 */
test.describe('Assistant thread tab strip geometry @stateful @web-assistant-state', () => {
  test.beforeEach(async ({ page }) => {
    await openAssistantWorkspace(page);
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }
    const tabList = page.getByRole('tablist', { name: 'Open assistant threads' });
    const initialTabCount = await tabList.getByRole('tab').count();
    for (let created = 1; initialTabCount + created <= 4; created += 1) {
      await page.getByTestId('assistant-new-thread-button').click();
      await expect(tabList.getByRole('tab')).toHaveCount(initialTabCount + created);
    }
  });

  test('paints the token geometry: 36px strip, 28px pill tabs, 4px gap, 20px close', async ({
    page,
  }) => {
    const strip = page.getByTestId('assistant-thread-tab-strip');
    const tabList = page.getByRole('tablist', { name: 'Open assistant threads' });
    await expect(tabList.getByRole('tab')).toHaveCount(4);

    const geometry = await strip.evaluate((root) => {
      const shells = [...root.querySelectorAll<HTMLElement>('[data-slot="tab-shell"]')];
      const rects = shells.map((shell) => shell.getBoundingClientRect());
      const tabs = shells.map((shell) => shell.querySelector<HTMLElement>('[role="tab"]'));
      const closes = shells.map((shell) =>
        shell.querySelector<HTMLElement>('[data-slot="tab-close"]')
      );
      return {
        closeSizes: closes.map((close) => {
          const rect = close?.getBoundingClientRect();
          return rect ? { height: rect.height, width: rect.width } : null;
        }),
        gaps: rects.slice(1).map((rect, index) => rect.left - (rects[index]?.right ?? 0)),
        radii: shells.map((shell) => getComputedStyle(shell).borderTopLeftRadius),
        stripHeight: root.getBoundingClientRect().height,
        tabFonts: tabs.map((tab) =>
          tab ? `${getComputedStyle(tab).fontSize}/${getComputedStyle(tab).fontWeight}` : null
        ),
        tabHeights: rects.map((rect) => rect.height),
      };
    });

    expect(geometry.stripHeight).toBe(36);
    expect(geometry.tabHeights).toEqual([28, 28, 28, 28]);
    expect(geometry.radii).toEqual(['6px', '6px', '6px', '6px']);
    expect(geometry.tabFonts).toEqual(['12px/500', '12px/500', '12px/500', '12px/500']);
    expect(geometry.gaps).toEqual([4, 4, 4]);
    // The close slot is reserved on every tab, visible or not.
    expect(geometry.closeSizes).toEqual(
      Array.from({ length: 4 }, () => ({ height: 20, width: 20 }))
    );
  });

  test('exposes only tabs inside the tablist to assistive technology', async ({ page }) => {
    const tabList = page.getByRole('tablist', { name: 'Open assistant threads' });
    await expect(tabList.getByRole('tab')).toHaveCount(4);

    // axe `aria-required-children`: the tablist owns tabs and nothing else.
    const exposedRoles = await tabList.evaluate((root) => {
      const roles: string[] = [];
      const walk = (element: Element): void => {
        for (const child of element.children) {
          if (child.getAttribute('aria-hidden') === 'true') {
            continue;
          }
          const role = child.getAttribute('role') ?? child.tagName.toLowerCase();
          if (role === 'presentation' || role === 'none' || role === 'div' || role === 'span') {
            walk(child);
            continue;
          }
          roles.push(role);
        }
      };
      walk(root);
      return roles;
    });
    expect(exposedRoles).toEqual(['tab', 'tab', 'tab', 'tab']);

    const snapshot = await tabList.ariaSnapshot();
    const childRoles = snapshot
      .split('\n')
      .filter((line) => /^ {2}- /.test(line))
      .map((line) => line.trim().replace(/^- /, '').split(/[ :]/)[0]);
    expect(childRoles).toEqual(['tab', 'tab', 'tab', 'tab']);
    // The mouse-only close buttons stay out of the tree entirely.
    await expect(tabList.getByRole('button')).toHaveCount(0);
  });
});
