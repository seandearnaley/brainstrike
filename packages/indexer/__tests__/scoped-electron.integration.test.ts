import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url));

it('uses the actual Electron utility writer and node:sqlite read-only scoped/vector reader', async () => {
  const executable: unknown = require('electron');
  if (typeof executable !== 'string') {
    throw new TypeError('Expected the installed Electron executable.');
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-scoped-electron-'));
  const userData = path.join(directory, 'electron-profile');
  const sessionData = path.join(userData, 'session-data');
  try {
    await mkdir(sessionData, { recursive: true });
    const { stdout, stderr } = await execute(
      executable,
      [
        path.join(import.meta.dirname, 'fixtures/scoped-electron-main.cjs'),
        `--user-data-dir=${userData}`,
        '--no-sandbox',
      ],
      {
        env: {
          ...process.env,
          BRAINSTRIKE_SCOPED_PROOF_DIR: directory,
          BRAINSTRIKE_SCOPED_PROOF_USER_DATA: userData,
          ELECTRON_RUN_AS_NODE: undefined,
        },
        maxBuffer: 1024 * 1024,
        timeout: 20_000,
      }
    );
    expect(stdout).toContain('SCOPED_ELECTRON_PROOF_OK:44.4.5');
    expect(stdout).toContain(
      `SCOPED_ELECTRON_PROFILE:${JSON.stringify({ sessionData, userData })}`
    );
    expect(stderr).not.toContain('UnhandledPromiseRejection');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
