// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';

const execute = promisify(execFile);
const desktop = resolve(import.meta.dirname, '../..');

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    MASTRA_TELEMETRY_DISABLED: 'true',
    NODE_ENV: 'test',
    // Root acquisition itself uses PowerShell on Windows, before configuration.
    PATH: process.env['PATH'],
    SystemRoot: process.env['SystemRoot'],
    TEMP: home,
    TMP: home,
    TMPDIR: home,
    USERPROFILE: home,
  };
}

beforeAll(async () => {
  await execute(process.execPath, ['scripts/build-main.mjs'], { cwd: desktop });
}, 30_000);

it('loads the built host platform without a second CommonJS Mastra runtime', async () => {
  // The loaded M3 startup profile found both ESM and CJS copies of Mastra in
  // one utility: its CJS platform reloaded the host kernel's existing runtime.
  const entries = (await readdir(join(desktop, 'dist'))).filter((name) =>
    /^agent-host-platform-entry\.m?js$/u.test(name)
  );
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (!entry) {
    throw new Error('The desktop build did not emit its host platform');
  }
  const home = await mkdtemp(join(tmpdir(), 'host-platform-load-'));
  try {
    // Loading the module acquires no platform resources. The isolated home and
    // OS-only inherited environment also keep this import proof credential-free.
    const { stdout } = await execute(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const platform = await import(${JSON.stringify(pathToFileURL(join(desktop, 'dist', entry)).href)});
if (typeof platform.createHostPlatform !== 'function') throw new Error('Missing platform factory');
const copies = Object.keys(require.cache).filter((name) => name.includes(join('@mastra', 'core')) && name.endsWith('.cjs'));
process.stdout.write(JSON.stringify(copies));`,
      ],
      { cwd: desktop, env: isolatedEnvironment(home) }
    );
    expect(JSON.parse(stdout)).toEqual([]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}, 30_000);

// The recorded M3 profile serialized desktop evaluation and the nested index.
// Observe a real emitted worker and Debugger script parsing, not source strings.
it('starts the real index worker before parsing desktop configuration and joins failed startup before Root reuse', async () => {
  const home = await mkdtemp(join(tmpdir(), 'host-platform-overlap-'));
  try {
    const { stdout } = await execute(
      process.execPath,
      [
        'src/__tests__/fixtures/host-platform-overlap.mjs',
        join(desktop, 'dist/agent-host-platform-entry.mjs'),
        join(home, 'state'),
      ],
      { cwd: desktop, env: isolatedEnvironment(home) }
    );
    const result = stdout.split('\n').find((line) => line.startsWith('OVERLAP_RESULT:'));
    expect(result).toBeDefined();
    expect(JSON.parse(result?.slice('OVERLAP_RESULT:'.length) ?? 'null')).toEqual({
      events: ['index-worker', 'desktop-configuration-parsed'],
      exited: 1,
      rootReleased: true,
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}, 30_000);
