import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Interaction-design fixture only. Production runtime parity is verified in
// BST-1719/1724/1725/1728; this page never calls an agent or writes a workspace.
const prototypeUrl = 'http://subagent-design.brainstrike.test/';
const prototypeFile = new URL('../../../docs/design/subagent-threads/index.html', import.meta.url);

test.beforeEach(async ({ page }) => {
  const html = await readFile(prototypeFile, 'utf8');
  await page.route(`${prototypeUrl}**`, (route) =>
    route.fulfill({ body: html, contentType: 'text/html' })
  );
  await page.goto(prototypeUrl);
});

test('child design: opens a child as a conversation, not forty inline rows @web-smoke', async ({
  page,
}) => {
  await page.getByRole('button', { exact: true, name: 'Open Cedar' }).click();
  await expect(page.getByRole('tab', { exact: true, name: 'Cedar' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('heading', { exact: true, name: 'Cedar' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Conversation' })).toHaveCount(1);
  await expect(page.getByRole('button', { exact: true, name: 'Open Wren' })).toBeVisible();
});

test('returns through ancestry with independent scroll, focus and draft @web-smoke', async ({
  page,
}) => {
  await page.setViewportSize({ height: 620, width: 1000 });
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await page.getByLabel('Message main assistant', { exact: true }).fill('Keep the report concise.');
  await conversation.evaluate((element) => {
    element.scrollTop = 80;
  });
  expect(
    await conversation.evaluate((element) => element.scrollHeight - element.clientHeight),
    'Fixture must be scrollable for the restoration check'
  ).toBeGreaterThan(80);
  const rootScroll = await conversation.evaluate((element) => element.scrollTop);
  expect(rootScroll).toBeGreaterThan(0);
  await page.getByRole('button', { exact: true, name: 'Open Cedar' }).click();
  await page.getByLabel('Message Cedar', { exact: true }).fill('Check memory.');
  await page.getByRole('button', { exact: true, name: 'Open Wren' }).click();
  await expect(page.getByRole('group', { name: 'Wren approval' })).toBeVisible();
  const ancestry = page.getByRole('navigation', { name: 'Conversation ancestry' });
  await ancestry.getByRole('button', { exact: true, name: 'Cedar' }).click();
  await expect(page.getByRole('button', { exact: true, name: 'Open Wren' })).toBeFocused();
  await expect(page.getByLabel('Message Cedar', { exact: true })).toHaveValue('Check memory.');
  await ancestry.getByRole('button', { exact: true, name: 'Repository report' }).click();
  await expect(page.getByRole('button', { exact: true, name: 'Open Cedar' })).toBeFocused();
  await expect(page.getByLabel('Message main assistant', { exact: true })).toHaveValue(
    'Keep the report concise.'
  );
  expect(await conversation.evaluate((element) => element.scrollTop)).toBe(rootScroll);
});

test('closing an approval tab leaves it waiting; reload retains identity and draft @web-smoke', async ({
  page,
}) => {
  await page.getByRole('button', { exact: true, name: 'View Wren' }).click();
  await page.getByLabel('Message Wren', { exact: true }).fill('A draft for Wren');
  await page.getByRole('button', { exact: true, name: 'Close Wren tab' }).click();
  await expect(page.getByRole('heading', { exact: true, name: 'Cedar' })).toBeVisible();
  await page.getByRole('button', { exact: true, name: 'Open Wren' }).click();
  await page.reload();
  await expect(page.getByRole('tab', { exact: true, name: 'Wren' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('group', { name: 'Wren approval' })).toBeVisible();
  await expect(page.getByLabel('Message Wren', { exact: true })).toHaveValue('A draft for Wren');
  await expect(page.getByRole('region', { name: 'Conversation' })).toHaveCount(1);
});

test('stopping one branch preserves parent and sibling outcomes @web-smoke', async ({ page }) => {
  await page.getByRole('button', { exact: true, name: 'Open Cedar' }).click();
  await page.getByRole('button', { exact: true, name: 'Stop Cedar branch' }).click();
  await expect(page.getByLabel('State of selected agent')).toHaveValue('cancelled');
  await page.getByRole('button', { exact: true, name: 'Open Wren' }).click();
  await expect(page.getByLabel('State of selected agent')).toHaveValue('cancelled');
  await page.getByRole('button', { exact: true, name: 'View Flint' }).click();
  await expect(page.getByLabel('State of selected agent')).toHaveValue('completed');
  await page.getByRole('button', { exact: true, name: 'View Repository report' }).click();
  await expect(page.getByLabel('State of selected agent')).toHaveValue('running');
  await expect(page.getByRole('region', { name: 'Conversation' })).toContainText(
    'Cedar stopped with its descendants'
  );
});

test('tabs support arrow, Home, End and Delete keys without duplication', async ({ page }) => {
  await page.getByRole('button', { exact: true, name: 'Open Cedar' }).click();
  await page.getByRole('button', { exact: true, name: 'Open Wren' }).click();
  const wren = page.getByRole('tab', { exact: true, name: 'Wren' });
  const cedar = page.getByRole('tab', { exact: true, name: 'Cedar' });
  const root = page.getByRole('tab', { exact: true, name: 'Repository report' });
  await wren.press('ArrowLeft');
  await expect(cedar).toBeFocused();
  await cedar.press('Home');
  await expect(root).toBeFocused();
  await root.press('End');
  await expect(wren).toBeFocused();
  await wren.press('Delete');
  await expect(wren).toHaveCount(0);
  await expect(cedar).toBeFocused();
  await page.getByRole('button', { exact: true, name: 'View Cedar' }).click();
  await expect(cedar).toHaveCount(1);
});

test('treegrid focus and expansion are separate from activation', async ({ page }) => {
  await page.getByRole('row', { name: /Collapse Repository report/ }).press('ArrowDown');
  await expect(page.getByRole('row', { name: /Collapse Cedar/ })).toBeFocused();
  await expect(page.getByRole('heading', { exact: true, name: 'Repository report' })).toBeVisible();
  await page.getByRole('row', { name: /Collapse Cedar/ }).press('ArrowLeft');
  await expect(page.getByRole('row', { name: /Expand Cedar/ })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(page.getByRole('button', { exact: true, name: 'View Wren' })).toHaveCount(0);
  await page.getByRole('row', { name: /Expand Cedar/ }).press('ArrowRight');
  await page.getByRole('row', { name: /Collapse Cedar/ }).press('ArrowRight');
  const wren = page.getByRole('row', { exact: true, name: 'View Wren' });
  await expect(wren).toBeFocused();
  await wren.press('Enter');
  await expect(page.getByRole('heading', { exact: true, name: 'Wren' })).toBeFocused();
});

test('follow-up and approval outcomes notify the owning parent', async ({ page }) => {
  await page.getByRole('button', { exact: true, name: 'Open Cedar' }).click();
  await page.getByLabel('Message Cedar', { exact: true }).fill('Include migration evidence.');
  await page.getByRole('button', { exact: true, name: 'Queue message' }).click();
  await expect(page.getByRole('region', { name: 'Conversation' })).toContainText(
    'Queued for the next safe boundary: Include migration evidence.'
  );
  await page.getByRole('button', { exact: true, name: 'Open Wren' }).click();
  await page.getByRole('button', { exact: true, name: 'Approve once' }).click();
  await expect(page.getByLabel('State of selected agent')).toHaveValue('completed');
  const ancestry = page.getByRole('navigation', { name: 'Conversation ancestry' });
  await ancestry.getByRole('button', { exact: true, name: 'Cedar' }).click();
  await expect(page.getByRole('region', { name: 'Conversation' })).toContainText(
    'Wren: approval granted'
  );
  await ancestry.getByRole('button', { exact: true, name: 'Repository report' }).click();
  await expect(page.getByRole('region', { name: 'Conversation' })).toContainText(
    'Cedar received direct user follow-up'
  );
});

test('terminal states stay distinct and preserve recorded activity', async ({ page }) => {
  await page.getByRole('button', { exact: true, name: 'Open Cedar' }).click();
  for (const [value, text] of [
    ['queued', 'Queued for a worker slot'],
    ['completed', 'Result returned to parent'],
    ['no-answer', 'Finished without an answer'],
    ['cancelled', 'Stopped'],
    ['failed', 'Run failed'],
  ]) {
    if (!(value && text)) {
      throw new Error('Missing state fixture');
    }
    await page.getByLabel('State of selected agent').selectOption(value);
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText(text);
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('Read 2 files');
  }
});

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`fits ${width}px in ${theme} with reduced motion`, async ({ page }, testInfo) => {
      await page.setViewportSize({ height: 844, width });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      if (theme === 'dark') {
        await page.getByRole('button', { name: 'Switch to dark theme' }).click();
      }
      await page.getByRole('button', { exact: true, name: 'Open Cedar' }).click();
      await page.getByRole('button', { exact: true, name: 'Open Wren' }).click();
      const geometry = await page.evaluate(() => ({
        animations: document.getAnimations().length,
        boxes: ['.lab', '.tabs', '.thread-head', '.conversation', '.composer-area'].map(
          (selector) => {
            const element = document.querySelector(selector);
            if (!element) {
              throw new Error(`Missing ${selector}`);
            }
            const rect = element.getBoundingClientRect();
            return {
              bottom: rect.bottom,
              height: rect.height,
              right: rect.right,
              selector,
              x: rect.x,
              y: rect.y,
            };
          }
        ),
        documentHeight: document.documentElement.scrollHeight,
        documentWidth: document.documentElement.scrollWidth,
      }));
      expect(geometry.documentWidth).toBeLessThanOrEqual(width);
      expect(geometry.documentHeight).toBeLessThanOrEqual(844);
      expect(geometry.animations).toBe(0);
      for (const box of geometry.boxes) {
        expect(box.x, box.selector).toBeGreaterThanOrEqual(0);
        expect(box.y, box.selector).toBeGreaterThanOrEqual(0);
        expect(box.right, box.selector).toBeLessThanOrEqual(width);
        expect(box.bottom, box.selector).toBeLessThanOrEqual(844);
        expect(box.height, box.selector).toBeGreaterThan(0);
      }
      await expect(
        page.getByRole('button', { exact: true, name: 'Approve once' })
      ).toBeInViewport();
      await expect(page.getByRole('button', { exact: true, name: 'Decline' })).toBeInViewport();
      await expect(page.getByLabel('Message Wren', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { exact: true, name: 'Send' })).toBeVisible();
      const activeTab = await page.getByRole('tab', { exact: true, name: 'Wren' }).boundingBox();
      if (!activeTab) {
        throw new Error('Missing active tab');
      }
      expect(activeTab.x).toBeGreaterThanOrEqual(0);
      expect(activeTab.x + activeTab.width).toBeLessThanOrEqual(width);
      const contrasts = await page.evaluate(() => {
        function channels(color: string): number[] {
          return [...color.matchAll(/[\d.]+/g)].map((match) => Number(match[0]));
        }
        function luminance(color: number[]): number {
          const linear = color.slice(0, 3).map((channel) => {
            const value = channel / 255;
            return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
          return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
        }
        return [
          ...document.querySelectorAll('.pill, .mark, .child-role, .composer-note, .sidebar-note'),
        ]
          .filter((element) => element.getBoundingClientRect().height > 0)
          .map((element) => {
            let ancestor: Element | null = element;
            let background: number[] = [];
            while (ancestor) {
              const candidate = channels(getComputedStyle(ancestor).backgroundColor);
              if (candidate.length === 3 || candidate[3] === 1) {
                background = candidate;
                break;
              }
              ancestor = ancestor.parentElement;
            }
            if (background.length < 3) {
              throw new Error('Missing opaque design background');
            }
            const foreground = luminance(channels(getComputedStyle(element).color));
            const backdrop = luminance(background);
            return {
              ratio:
                (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05),
              text: element.textContent,
            };
          });
      });
      for (const contrast of contrasts) {
        expect(contrast.ratio, contrast.text ?? '').toBeGreaterThanOrEqual(4.5);
      }
      const screenshotPath = testInfo.outputPath(`wren-${theme}-${width}.png`);
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach(`wren-${theme}-${width}`, {
        contentType: 'image/png',
        path: screenshotPath,
      });
    });
  }
}

test('root stop still controls live descendants after the root finishes', async ({ page }) => {
  await page.getByLabel('State of selected agent').selectOption('completed');
  await expect(page.getByRole('button', { exact: true, name: 'Stop all agents' })).toBeEnabled();
  await page.getByRole('button', { exact: true, name: 'Stop all agents' }).click();
  await page.getByRole('button', { exact: true, name: 'Open Cedar' }).click();
  await expect(page.getByLabel('State of selected agent')).toHaveValue('cancelled');
});

test('closing the final root tab leaves a reopenable conversation, not a new run', async ({
  page,
}) => {
  await page.getByRole('button', { exact: true, name: 'Close Repository report tab' }).click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.getByRole('button', { exact: true, name: 'View Repository report' }).click();
  await expect(page.getByLabel('State of selected agent')).toHaveValue('running');
  await expect(page.getByRole('button', { exact: true, name: 'Open Cedar' })).toBeVisible();
});

test('saved-state corruption remains visible and recoverable without silently resetting', async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('bst-1717-interaction-study-v1', '{broken')
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Saved design state could not be loaded');
  await expect(page.getByRole('tab')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('bst-1717-interaction-study-v1'))).toBe(
    '{broken'
  );
  await page.getByRole('button', { exact: true, name: 'Reset' }).click();
  await expect(page.getByRole('heading', { exact: true, name: 'Repository report' })).toBeVisible();
  await expect(page.getByRole('alert')).toBeHidden();
});

test('same-conversation state changes preserve a valid scrolled position', async ({ page }) => {
  await page.setViewportSize({ height: 620, width: 1000 });
  await page.getByRole('button', { exact: true, name: 'Open Cedar' }).click();
  const viewport = page.getByRole('region', { name: 'Conversation' });
  await viewport.evaluate((element) => {
    element.scrollTop = 80;
  });
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(80);
  await page.getByLabel('State of selected agent').selectOption('queued');
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(80);
  await page.getByRole('button', { exact: true, name: 'Stop Cedar branch' }).click();
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(80);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(80);
});

test('saved presentation strings cannot become executable markup', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.addInitScript(() => {
    const key = 'bst-1717-interaction-study-v1';
    const saved: { nodes: { cedar: { name?: string } } } | null = JSON.parse(
      sessionStorage.getItem(key) ?? 'null'
    );
    // Ensure the fixture has a saved state before corrupting it.
    if (!saved) {
      throw new Error('Expected saved design state');
    }
    saved.nodes.cedar.name = '<img src=x onerror="document.title=\'INJECTED\'">';
    sessionStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await expect(page).toHaveTitle('Subagent threads · Brainstrike design');
  await expect(page.getByRole('button', { exact: true, name: 'Open Cedar' })).toBeVisible();
});
