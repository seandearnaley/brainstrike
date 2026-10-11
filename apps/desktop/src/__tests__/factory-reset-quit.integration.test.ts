// @vitest-environment node
// Quitting during reset must finish accepted deletion and join existing owners,
// without opening another app session under the terminal shutdown deadline.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron } from 'playwright';
import { expect, test } from 'vitest';
import { createDisposableAppProfile } from './helpers/disposable-app-profile';

const desktop = resolve(import.meta.dirname, '../..');

test('quitting while a factory reset finishes lets the reset complete', {
  // Owner excluded Windows Factory Reset from M3; ordinary quit stays covered.
  skip: process.platform === 'win32',
  timeout: getAdjustedTimeout('e2e'),
}, async () => {
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
    executablePath:
      process.env['BRAINSTRIKE_TEST_ELECTRON_EXEC_PATH'] ??
      join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
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
    // The agent host is up once it publishes its record.
    await expect.poll(() => existsSync(join(profile, 'host.json')), { timeout: 60_000 }).toBe(true);
    await window.evaluate(() => {
      const api = (
        window as unknown as { electronAPI: { db: { resetLocal: () => Promise<unknown> } } }
      ).electronAPI;
      // The renderer is replaced by the reset: nobody awaits the answer here.
      void api.db.resetLocal().catch(() => undefined);
    });
    // Quit inside the reset: it has stopped the browser pane and not yet purged the data.
    await expect
      .poll(() => output.includes('Desktop browser sessions cleared (factory reset)'), {
        timeout: 60_000,
      })
      .toBe(true);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
    await exited;

    expect(main.exitCode).toBe(0);
    expect(output).not.toContain('Failed to reset desktop application data');
    expect(output).not.toContain('MCP is unavailable');
    expect(output).toContain('Desktop factory reset completed');
    expect(existsSync(sentinel)).toBe(false);
  } finally {
    await app.close();
  }
});
