// @vitest-environment node
// Quitting while a factory reset is still finishing must let the reset finish.
// Shutdown closed MCP while the reset's reopen was starting the agent host: the
// host's start was refused ("MCP is unavailable"), and the reset reported
// itself failed although its purge had run.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron } from 'playwright';
import { expect, test } from 'vitest';
import { createDisposableAppProfile } from './helpers/disposable-app-profile';

const desktop = resolve(import.meta.dirname, '../..');

test('quitting while a factory reset finishes lets the reset complete', {
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
    // The purge has run; the reset is still reopening what it closed.
    await expect.poll(() => existsSync(sentinel), { timeout: 60_000 }).toBe(false);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
    await exited;

    expect(output).not.toContain('Failed to reset desktop application data');
    expect(output).not.toContain('MCP is unavailable');
    expect(output).toContain('Desktop factory reset completed');
  } finally {
    await app.close();
  }
});
