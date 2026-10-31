import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLoginShellEnvironment } from '../login-shell-environment';

// What launchd hands an app started from the Dock or Finder.
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});

/** A home whose login profile is the only thing that puts `login-only-tool` on PATH. */
async function homeWithLoginProfile(profile: (toolDir: string) => string): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'login-shell-env-'));
  homes.push(home);
  const toolDir = path.join(home, 'login-only-bin');
  await mkdir(toolDir);
  await writeFile(path.join(toolDir, 'login-only-tool'), '#!/bin/sh\necho login-only-tool ran\n', {
    mode: 0o755,
  });
  await writeFile(path.join(home, '.bash_profile'), profile(toolDir));
  return home;
}

/** Runs `command` the way executeCommand does: `$SHELL -c` with the given environment. */
function runCommand(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(env['SHELL'] ?? '/bin/sh', ['-c', command], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('resolveLoginShellEnvironment', () => {
  // The stated per-OS exception: docs/agents/platform-contracts.md, "Login-shell environment".
  it.skipIf(process.platform === 'win32')(
    'gives a command child launched by launchd the PATH that only the login shell sets',
    async () => {
      const home = await homeWithLoginProfile((toolDir) => `export PATH="${toolDir}:$PATH"\n`);
      const launchEnv = { HOME: home, PATH: LAUNCHD_PATH, SHELL: '/bin/bash' };
      expect((await runCommand('login-only-tool', launchEnv)).code).toBe(127);

      const shellEnvironment = await resolveLoginShellEnvironment({
        argv: [],
        env: launchEnv,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(shellEnvironment.status).toBe('resolved');
      const env: NodeJS.ProcessEnv = {
        ...launchEnv,
        ...(shellEnvironment.status === 'resolved' ? shellEnvironment.env : {}),
      };
      expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
      expect(await runCommand('login-only-tool', env)).toEqual({
        code: 0,
        stdout: 'login-only-tool ran\n',
      });
    }
  );

  // The stated per-OS exception: docs/agents/platform-contracts.md, "Login-shell environment".
  it.skipIf(process.platform === 'win32')(
    'reports a login shell that exits with an error instead of resolving',
    async () => {
      const home = await homeWithLoginProfile(() => 'exit 3\n');

      const shellEnvironment = await resolveLoginShellEnvironment({
        argv: [],
        env: { HOME: home, PATH: LAUNCHD_PATH, SHELL: '/bin/bash' },
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(shellEnvironment).toEqual({
        message: 'The login shell /bin/bash exited with code 3 before printing its environment.',
        shell: '/bin/bash',
        status: 'failed',
      });
    }
  );

  // The stated per-OS exception: docs/agents/platform-contracts.md, "Login-shell environment".
  it.skipIf(process.platform === 'win32')(
    'stops a login shell that hangs, with what it started, and reports it',
    async () => {
      const home = await homeWithLoginProfile(() => 'sleep 30 & echo $! > "$HOME/sleeper"\nwait\n');

      const shellEnvironment = await resolveLoginShellEnvironment({
        argv: [],
        env: { HOME: home, PATH: LAUNCHD_PATH, SHELL: '/bin/bash' },
        execPath: process.execPath,
        platform: process.platform,
        timeoutMs: 500,
      });

      expect(shellEnvironment).toEqual({
        message: 'The login shell /bin/bash did not print its environment within 0.5 s.',
        shell: '/bin/bash',
        status: 'failed',
      });
      const sleeper = Number((await readFile(path.join(home, 'sleeper'), 'utf8')).trim());
      await expect.poll(() => isRunning(sleeper)).toBe(false);
    }
  );

  it('keeps the launch environment when a shell, test mode or Windows started the app', async () => {
    // A shell that cannot start proves nothing was spawned: spawning it would fail.
    const launchEnv = { HOME: os.tmpdir(), PATH: LAUNCHD_PATH, SHELL: '/nonexistent/shell' };
    const resolve = (overrides: {
      argv?: string[];
      env?: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
    }) =>
      resolveLoginShellEnvironment({
        argv: overrides.argv ?? [],
        env: { ...launchEnv, ...overrides.env },
        execPath: process.execPath,
        platform: overrides.platform ?? 'darwin',
      });

    await expect(resolve({ env: { SHLVL: '1' } })).resolves.toEqual({
      reason: 'launched-from-shell',
      status: 'skipped',
    });
    await expect(resolve({ argv: ['--test-mode'] })).resolves.toEqual({
      reason: 'test-mode',
      status: 'skipped',
    });
    await expect(resolve({ platform: 'win32' })).resolves.toEqual({
      reason: 'windows',
      status: 'skipped',
    });
  });
});
