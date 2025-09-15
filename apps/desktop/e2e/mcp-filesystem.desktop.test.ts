import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronAppContext } from './utils/electron-helpers';
import { closeElectronApp, launchElectronApp, waitForAppReady } from './utils/electron-helpers';

test.describe('MCP filesystem tool (desktop)', () => {
  // CI environments may use Electron/Playwright combinations that add
  // unsupported flags (e.g., --remote-debugging-port=0). Skip to avoid flakes.
  test.skip(!!process.env.CI, 'Skipped in CI: Electron launch flag incompatibility.');
  let appContext: ElectronAppContext;

  test.beforeEach(async () => {
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
  });

  test.afterEach(async () => {
    if (appContext) await closeElectronApp(appContext);
  });

  test('list files tool renders tool card', async () => {
    const page = appContext.window;

    // Determine userData MCP config path
    const userData = await appContext.app.evaluate(async ({ app }) => app.getPath('userData'));
    const mcpDir = path.join(userData, 'mcp');
    const cfgPath = path.join(mcpDir, 'mcp.config.json');
    await fs.mkdir(mcpDir, { recursive: true });
    const baseDir = process.cwd();
    const cfg = {
      servers: [
        {
          name: 'filesystem',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', baseDir],
        },
      ],
    };
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');

    // Start watching for changes (ensures loader picks it up)
    await page.evaluate(async () => {
      (window as unknown as { mcp?: { watch?: () => Promise<void> } }).mcp?.watch?.();
    });

    // Ensure right panel is visible
    const rightPanel = page.locator('[data-panel-id="right-panel"]');
    if (!(await rightPanel.isVisible())) {
      await page.getByRole('button', { name: 'Show right panel' }).click();
      await expect(rightPanel).toBeVisible();
    }

    // Switch to Props tab and locate chat panel
    await page
      .getByRole('tab', { name: 'Props' })
      .or(page.getByRole('button', { name: 'Props' }))
      .click();
    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();

    // Ask to list files
    await page.locator('#assistant-input').fill('list files');
    await page.getByRole('button', { name: 'Send' }).click();

    // Expect a tool card for filesystem.list
    const toolCards = panel.locator('[data-testid="tool-part"][data-tool="filesystem.list"]');
    await expect(toolCards.first()).toBeVisible({ timeout: 10000 });
  });
});
