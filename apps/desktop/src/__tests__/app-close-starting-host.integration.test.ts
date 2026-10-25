// @vitest-environment node
// Quitting the app while its agent host is still starting must not start another
// one. Shutdown fences profile admission before it joins the renderer's in-flight
// host connect; otherwise that connect's failed start was retried and a second
// host spawned during shutdown. It also fences that admission
// before Main's MCP control closes: the starting host's MCP handshake was refused
// ("MCP is unavailable") when the control closed first.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron } from 'playwright';
import { expect, test } from 'vitest';
import { createDisposableAppProfile } from './helpers/disposable-app-profile';
import { electronExecutablePath } from './helpers/electron-executable';

const desktop = resolve(import.meta.dirname, '../..');
test('quitting while the agent host is starting spawns no second host', {
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
  // Hold the existing bootstrap admission promise after the real host spawns.
  // A visible window means Main has already bound the host platform, so waiting
  // for firstWindow cannot establish the starting phase this test exercises.
  // Every host Main spawns is recorded as it is spawned, so none escapes the count.
  const entry = join(root, 'hold-main-admission.cjs');
  const phaseMarker = join(root, 'main-admission-held');
  const spawnedHosts = join(root, 'spawned-hosts');
  await writeFile(spawnedHosts, '');
  await writeFile(
    entry,
    `const childProcess = require('node:child_process');
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const child = spawn(command, args, options);
  if (String(args?.[0]).endsWith('agent-host-entry.js')) {
    require('node:fs').appendFileSync(${JSON.stringify(spawnedHosts)}, child.pid + '\\n');
  }
  return child;
};
require('node:module').syncBuiltinESMExports();
const { getDesktopBootstrapRuntime } = require(${JSON.stringify(join(desktop, 'dist/desktop-bootstrap-runtime.js'))});
const runtime = getDesktopBootstrapRuntime();
const waitForProfileLaunch = runtime.waitForProfileLaunch;
runtime.waitForProfileLaunch = async (acquisition) => {
  await waitForProfileLaunch(acquisition);
  require('node:fs').writeFileSync(${JSON.stringify(phaseMarker)}, 'host spawned; Main admission held');
  await new Promise(() => {});
};
require(${JSON.stringify(join(desktop, 'dist/main.js'))});
`
  );
  const app = await _electron.launch({
    args: [
      entry,
      '--test-mode',
      `--user-data-dir=${root}`,
      '--brainstrike-desktop-launch-mode=test-built',
    ],
    env,
    executablePath: electronExecutablePath(),
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
  const hosts = async (): Promise<string[]> =>
    (await readFile(spawnedHosts, 'utf8')).split('\n').filter((line) => line !== '');
  try {
    // Bootstrap has spawned the real host and holds Main admission, so the host
    // cannot be ready: its platform is not bound.
    await expect.poll(() => existsSync(phaseMarker)).toBe(true);
    expect(await hosts()).toHaveLength(1);

    // Quit as Playwright's close does, but keep the inspector connection, which
    // its close drops at once, so the whole graceful shutdown stays observable.
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
    await exited;
    expect(main.exitCode).toBe(0);
    expect(await hosts()).toHaveLength(1);
    expect(output).not.toContain('MCP is unavailable');
  } finally {
    await app.close();
  }
});
