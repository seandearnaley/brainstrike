// @vitest-environment node
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { expect, test } from 'vitest';
import { createDisposableAppProfile } from './helpers/disposable-app-profile';
import { electronExecutablePath } from './helpers/electron-executable';

const desktop = resolve(import.meta.dirname, '../..');

/**
 * View → Reload on the app's visible window, the way the user picks it, once Main has loaded
 * its first document. `#root > *` already matches index.html's static startup shell, and a
 * reload while Main's startup still awaits that first load aborts it (ERR_ABORTED).
 */
async function reloadFromMenu(app: ElectronApplication, page: Page): Promise<void> {
  const id = await (await app.browserWindow(page)).evaluate((window) => window.id);
  await app.evaluate(async ({ BrowserWindow, Menu }, windowId) => {
    const target = BrowserWindow.fromId(windowId);
    const item = Menu.getApplicationMenu()
      ?.items.find(({ label }) => label === 'View')
      ?.submenu?.items.find(({ label }) => label === 'Reload');
    if (!(target && item)) {
      throw new Error('The app Reload menu target is unavailable');
    }
    if (target.webContents.isLoading()) {
      await new Promise<void>((resolve) => {
        target.webContents.once('did-stop-loading', () => resolve());
      });
    }
    item.click(undefined, target, target.webContents);
  }, id);
}

for (const control of [
  'preparation failure',
  'cancelled native close',
  'reloaded document',
] as const) {
  test(`app-owned close remains terminal after ${control}`, {
    timeout: getAdjustedTimeout('e2e'),
  }, async () => {
    const { root, evidence } = await createDisposableAppProfile('brainstrike-terminal-close-');
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        name !== 'ELECTRON_RUN_AS_NODE' &&
        !/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|AWS_)/u.test(name)
      ) {
        env[name] = value;
      }
    }
    Object.assign(env, {
      BRAINSTRIKE_DB_PROFILE: 'terminal-close',
      BRAINSTRIKE_DB_ROOT_PATH: root,
      BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
      BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES: '1',
      BRAINSTRIKE_E2E_USER_DATA_DIR: root,
      ELECTRON_IS_E2E_TEST: 'true',
      LOG_LEVEL: 'info',
    });
    const app = await _electron.launch({
      args: [
        join(desktop, 'dist/main.js'),
        '--test-mode',
        `--user-data-dir=${root}`,
        '--brainstrike-desktop-launch-mode=test-built',
      ],
      env,
      executablePath: electronExecutablePath(),
    });
    const mainProcess = app.process();
    let output = '';
    const capture = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    mainProcess.stdout?.on('data', capture);
    mainProcess.stderr?.on('data', capture);
    try {
      const page = await app.firstWindow();
      await page.waitForSelector('#root > *');
      if (control === 'reloaded document') {
        // The prepare latch belongs to one document generation: Main flushes this document
        // before its reload, and the replacement prepares again, on its own, at quit.
        const flushed = page.waitForEvent('console', {
          predicate: (message) => message.text() === 'first generation flushed',
        });
        await page.evaluate(() => {
          window.agentHost?.onPrepareClose(async () => {
            console.info('first generation flushed');
          });
        });
        const replaced = page.waitForEvent('framenavigated', {
          predicate: (frame) => frame === page.mainFrame(),
        });
        await reloadFromMenu(app, page);
        await flushed;
        await replaced;
        await page.waitForSelector('#root > *');
      }
      await page.evaluate((mode) => {
        if (!window.agentHost) {
          throw new Error('Renderer close capability is unavailable');
        }
        if (mode !== 'cancelled native close') {
          window.agentHost.onPrepareClose(async () => {
            throw new Error('Expected terminal preparation failure');
          });
          return;
        }
        window.onbeforeunload = () => false;
      }, control);
      const exited = once(mainProcess, 'exit', { signal: AbortSignal.timeout(15_000) });
      await app.evaluate(({ app: electronApp }) => {
        electronApp.quit();
      });
      await exited;
      expect(mainProcess.signalCode).toBeNull();
      expect(page.isClosed()).toBe(true);
      if (control !== 'cancelled native close') {
        // The latest document's own preparation ran at quit, and quit still ended it.
        expect(mainProcess.exitCode).toBe(0);
        expect(output).toContain('Desktop renderer producers failed to close');
        expect(output).toContain('Graceful shutdown completed with cleanup failures');
        expect(output).not.toContain('forcing exit');
        return;
      }
      // ADR-0026 R4: app-owned quit is terminal, so the page's beforeunload veto is
      // overridden and the window close is joined; no deadline forces an exit.
      expect(mainProcess.exitCode).toBe(0);
      const completed = output
        .split('\n')
        .find(
          (line) => line.startsWith('{') && line.includes('"msg":"Graceful shutdown completed"')
        );
      if (!completed) {
        throw new Error('Main did not report its completed graceful shutdown');
      }
      expect(JSON.parse(completed)).toMatchObject({
        steps: expect.arrayContaining([
          { elapsedMs: expect.any(Number), failed: false, step: 'renderers' },
        ]),
      });
      expect(output).not.toContain('Graceful shutdown completed with cleanup failures');
    } finally {
      await writeFile(join(evidence, 'main.log'), output);
      await app.close();
    }
  });
}
