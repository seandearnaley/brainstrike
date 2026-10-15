// @vitest-environment node
// Quitting during reset must finish accepted deletion and join existing owners,
// without opening another app session under the terminal shutdown deadline.
// ADR-0015: that exact terminal cancellation is expected, so it logs no error.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron, type Page } from 'playwright';
import { expect, test } from 'vitest';
import { createDisposableAppProfile } from './helpers/disposable-app-profile';
import { electronExecutablePath } from './helpers/electron-executable';

const desktop = resolve(import.meta.dirname, '../..');

/** Main's pino records at error level or above. */
function errorRecords(output: string): string[] {
  return output.split('\n').filter((line) => {
    if (!line.startsWith('{')) {
      return false;
    }
    try {
      const { level } = JSON.parse(line) as { level?: unknown };
      return typeof level === 'number' && level >= 50;
    } catch {
      return false;
    }
  });
}

const QUIT_POINTS = {
  // It has stopped the browser pane and not yet purged the data.
  purge: async (_window: Page, output: () => string) => {
    await expect
      .poll(() => output().includes('Desktop browser sessions cleared (factory reset)'), {
        timeout: 60_000,
      })
      .toBe(true);
  },
  // The data is gone and the replacement renderer is starting, while Main
  // still owes the profile reopen its startup requests are waiting on.
  replacement: async (window: Page) => {
    await window.waitForEvent('load', { timeout: 60_000 });
  },
} as const;

test.for(Object.keys(QUIT_POINTS) as (keyof typeof QUIT_POINTS)[])(
  'quitting while a factory reset finishes lets the reset complete (%s)',
  {
    // Owner excluded Windows Factory Reset from M3; ordinary quit stays covered.
    skip: process.platform === 'win32',
    timeout: getAdjustedTimeout('e2e'),
  },
  async (quitPoint) => {
    const { root } = await createDisposableAppProfile('brainstrike-reset-quit-');
    const profile = join(root, 'profiles/reset-quit');
    await mkdir(profile, { recursive: true });
    const sentinel = join(root, 'factory-reset-sentinel');
    await writeFile(sentinel, 'stale', 'utf8');
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        name !== 'ELECTRON_RUN_AS_NODE' &&
        !/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|AWS_)/.test(name)
      ) {
        env[name] = value;
      }
    }
    Object.assign(env, {
      BRAINSTRIKE_DB_PROFILE: 'reset-quit',
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
    const main = app.process();
    let output = '';
    main.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    main.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const exited = new Promise<void>((done) => {
      if (main.exitCode !== null || main.signalCode !== null) {
        done();
        return;
      }
      main.once('exit', () => done());
    });
    try {
      const window = await app.firstWindow();
      // The page survives the reset's renderer replacement, so this sees both renderers.
      const rendererErrors: string[] = [];
      window.on('console', (message) => {
        if (message.type() === 'error') {
          rendererErrors.push(message.text());
        }
      });
      window.on('pageerror', (cause) => rendererErrors.push(cause.message));
      // The agent host is up once it publishes its record, and startup work that
      // borrows the profile has settled once the snapshot GC reports.
      await expect
        .poll(() => existsSync(join(profile, 'host.json')), { timeout: 60_000 })
        .toBe(true);
      await expect
        .poll(() => output.includes('Workspace snapshot startup GC completed'), {
          timeout: 60_000,
        })
        .toBe(true);
      await window.evaluate(() => {
        const api = globalThis.window.electronAPI;
        if (!(api && 'factoryReset' in api)) {
          throw new Error('Factory reset capability unavailable');
        }
        // The renderer is replaced by the reset: nobody awaits the answer here.
        void api.factoryReset.resetLocal().catch(() => undefined);
      });
      await QUIT_POINTS[quitPoint](window, () => output);
      await app.evaluate(({ app: electronApp }) => {
        electronApp.quit();
      });
      await exited;

      expect(main.exitCode).toBe(0);
      expect(output).not.toContain('Failed to reset desktop application data');
      expect(output).not.toContain('MCP is unavailable');
      expect(output).toContain('Desktop factory reset completed');
      expect(errorRecords(output)).toEqual([]);
      expect(rendererErrors).toEqual([]);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      await app.close();
    }
  }
);
