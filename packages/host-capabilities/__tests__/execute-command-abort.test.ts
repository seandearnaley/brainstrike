/**
 * A stopped command ends at once: an abort kills its whole group without a SIGTERM grace, and
 * the call settles at the shell's exit, even while a process that left the group still holds the
 * command's pipes.
 */
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  disposeLiveChildProcesses,
  runDetachedProcess,
  type SpawnOutcome,
} from '../src/native-tools/execute-command-tool.ts';
import { packageWindowsCommandEntry } from './fixtures/execute-command.ts';

const IGNORE_SIGTERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6);";
// A shell whose child starts a process outside the group and exits, so the process, holding the
// shell's stdout, is no descendant of the shell either. The child prints that pid.
const DAEMONIZE = `
const { spawn } = require('node:child_process');
const escapee = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORE_SIGTERM)}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
process.stdout.write('escapee ' + escapee.pid + '\\n', () => process.exit(0));
`;
const ESCAPE = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(DAEMONIZE)}], { stdio: ['ignore', 'inherit', 'ignore'] });
setInterval(() => {}, 1e6);
`;

const escapees: number[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const pid of escapees.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

/** Starts `script` under node and resolves once it has printed its first line. */
function start(
  script: string,
  signal: AbortSignal
): { readonly outcome: Promise<SpawnOutcome>; readonly printed: Promise<string> } {
  const printed = Promise.withResolvers<string>();
  const outcome = runDetachedProcess({
    argv: ['-e', script],
    cwd: tmpdir(),
    executable: process.execPath,
    signal,
    streamer: (part) => {
      if (part.stream === 'stdout') {
        printed.resolve(part.chunk);
      }
    },
    timeoutMs: 600_000,
    windowsCommandEntry: packageWindowsCommandEntry,
  });
  return { outcome, printed: printed.promise };
}

describe.skipIf(process.platform === 'win32')('a stopped command', () => {
  test('an abort ends a command that ignores SIGTERM without a grace', async () => {
    // No timer can fire: the only way the call settles is a kill sent at the abort itself.
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    const controller = new AbortController();
    const { outcome, printed } = start(
      `${IGNORE_SIGTERM} process.stdout.write('ready\\n');`,
      controller.signal
    );
    await printed;
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ exitCode: null, signal: 'SIGKILL' });
  }, 10_000);

  test('an abort settles while a process that left the group still holds the pipes', async () => {
    const controller = new AbortController();
    const { outcome, printed } = start(ESCAPE, controller.signal);
    escapees.push(Number((await printed).trim().split(' ')[1]));
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ exitCode: null });
  }, 10_000);

  test('disposal returns while a process that left the group still holds the pipes', async () => {
    const { outcome, printed } = start(ESCAPE, new AbortController().signal);
    escapees.push(Number((await printed).trim().split(' ')[1]));
    await expect(disposeLiveChildProcesses()).resolves.toBe(1);
    await expect(outcome).resolves.toMatchObject({ exitCode: null, signal: 'SIGKILL' });
  }, 10_000);
});
