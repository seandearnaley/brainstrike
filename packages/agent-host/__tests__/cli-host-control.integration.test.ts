import { execFile } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { removeFixtureRoot } from './fixtures/cooperative-host-fixture.js';

const cli = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const platform = fileURLToPath(new URL('./fixtures/process-platform.mjs', import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await removeFixtureRoot(root);
  }
});

// Cold stop and joined live shutdown use Studio's typed host-control contract.
// Keep this fixture's cold discovery proof independent while that contract lands.
test('cold host status never starts the supplied platform or acquires the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-cli-control-'));
  roots.push(root);
  const code = await new Promise<number>((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, '--data-root', root, '--platform', platform, 'host', 'status'],
      {
        env: {
          BRAINSTRIKE_M3_TEST_TOOL: 'fail',
          LC_ALL: 'C',
          PATH: process.env['PATH'],
          SystemRoot: process.env['SystemRoot'],
          TZ: 'UTC',
        },
        timeout: 10_000,
        windowsHide: true,
      },
      (cause) => {
        if (!cause) {
          resolve(0);
        } else if (typeof cause.code === 'number') {
          resolve(cause.code);
        } else {
          reject(cause);
        }
      }
    );
  });
  expect(code).toBe(1);
  expect(RootLock.inspect(root)).toBeNull();
  await expect(access(join(root, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(root, 'fixture-platform-pids'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
