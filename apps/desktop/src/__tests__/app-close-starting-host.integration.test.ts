// @vitest-environment node
// Quitting the app while its agent host utility is still starting must not start
// another one. Shutdown fences profile admission before it joins the renderer's
// in-flight host connect; otherwise that connect's failed start was retried and a
// second host utility spawned during shutdown. It also fences that admission
// before Main's MCP control closes: the starting host's MCP handshake was refused
// ("MCP is unavailable") when the control closed first.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron, type ElectronApplication } from 'playwright';
import { expect, test } from 'vitest';
import { createDisposableAppProfile } from './helpers/disposable-app-profile';

const desktop = resolve(import.meta.dirname, '../..');
/** The name host-lease-manager forks every host utility under (Electron's ProcessMetric name). */
const HOST_UTILITY = 'Brainstrike Host Lease';

/** Live host utilities as pid@creationTime, or null once Main no longer answers. */
async function hostUtilities(app: ElectronApplication): Promise<string[] | null> {
  try {
    return await app.evaluate(
      ({ app: electronApp }, name) =>
        electronApp
          .getAppMetrics()
          .filter((metric) => metric.type === 'Utility' && metric.name === name)
          .map((metric) => `${metric.pid}@${metric.creationTime}`),
      HOST_UTILITY
    );
  } catch {
    return null; // Main has exited or is tearing down its inspector connection.
  }
}

test('quitting while the agent host is starting spawns no second host utility', {
  timeout: getAdjustedTimeout('e2e'),
}, async () => {
  const { root } = await createDisposableAppProfile('brainstrike-close-starting-host-');
  const profile = join(root, 'profiles/close-starting');
  await mkdir(profile, { recursive: true });
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
    BRAINSTRIKE_DB_PROFILE: 'close-starting',
    BRAINSTRIKE_DB_ROOT_PATH: root,
    BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
    BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES: '1',
    BRAINSTRIKE_E2E_USER_DATA_DIR: root,
    ELECTRON_IS_E2E_TEST: 'true',
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
  const capture = (chunk: Buffer): void => {
    output += chunk.toString('utf8');
  };
  main.stdout?.on('data', capture);
  main.stderr?.on('data', capture);
  const exited = new Promise<void>((done) => {
    if (main.exitCode !== null || main.signalCode !== null) {
      done();
      return;
    }
    main.once('exit', () => done());
  });
  const spawned = new Set<string>();
  try {
    await app.firstWindow();
    // The renderer connects on load, which starts the first host utility.
    await expect
      .poll(async () => {
        for (const utility of (await hostUtilities(app)) ?? []) {
          spawned.add(utility);
        }
        return spawned.size;
      })
      .toBe(1);
    // Still starting: a ready host would publish its record.
    expect(existsSync(join(profile, 'host.json'))).toBe(false);

    // Quit as Playwright's close does, but keep the inspector connection, which
    // its close drops at once, so the whole graceful shutdown stays observable.
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
    for (;;) {
      const live = await hostUtilities(app);
      if (live === null) {
        break;
      }
      for (const utility of live) {
        spawned.add(utility);
      }
      await delay(20);
    }
    await exited;
    expect([...spawned]).toHaveLength(1);
    expect(output).not.toContain('MCP is unavailable');
  } finally {
    await app.close();
  }
});
