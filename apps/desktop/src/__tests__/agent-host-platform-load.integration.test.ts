// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const desktop = resolve(import.meta.dirname, '../..');

it('loads the built host platform without a second CommonJS Mastra runtime', async () => {
  // The loaded M3 startup profile found both ESM and CJS copies of Mastra in
  // one utility: its CJS platform reloaded the host kernel's existing runtime.
  await execute(process.execPath, ['scripts/build-main.mjs'], { cwd: desktop });
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
    // empty inherited environment also keep this import proof credential-free.
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
      { cwd: desktop, env: { HOME: home, MASTRA_TELEMETRY_DISABLED: 'true', NODE_ENV: 'test' } }
    );
    expect(JSON.parse(stdout)).toEqual([]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}, 30_000);
