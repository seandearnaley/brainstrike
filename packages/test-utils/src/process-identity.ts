// A process's OS identity for tests that check which processes are still running: its pid
// and its OS start time, which defeats pid reuse. Product code never judges a process by it.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

type ProcessIdentityAddon = Pick<
  typeof import('@brainstrike/windows-job-native'),
  'getProcessCreationTime' | 'waitForProcessExit'
>;
let addon: ProcessIdentityAddon | undefined;
function windowsProcessIdentity(): ProcessIdentityAddon {
  addon ??= createRequire(import.meta.url)(
    '@brainstrike/windows-job-native'
  ) as ProcessIdentityAddon;
  return addon;
}

/** `ps` in the C locale and UTC, so the same start time always formats the same way. */
function psEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['LC_ALL'] = 'C';
  env['TZ'] = 'UTC';
  return env;
}

/** OS start time of a live pid, or null once it has exited (a zombie has exited too). */
export function processStartTime(pid: number): string | null {
  if (process.platform === 'win32') {
    return windowsProcessIdentity().getProcessCreationTime(pid);
  }
  try {
    const out = execFileSync('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: psEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const row = /^(\S+)\s+(.+)$/.exec(out);
    return !row || row[1]?.startsWith('Z') ? null : (row[2] ?? null);
  } catch (e) {
    if (e !== null && typeof e === 'object' && 'status' in e && e.status === 1) {
      return null; // ps exits 1 when the pid does not exist
    }
    throw e;
  }
}

/** Settles once the process `pid` that started at `start` has exited. */
export async function joinProcessExit(pid: number, start: string): Promise<void> {
  if (process.platform === 'win32') {
    await windowsProcessIdentity().waitForProcessExit(pid, start);
    return;
  }
  while (processStartTime(pid) === start) {
    await delay(25);
  }
}
