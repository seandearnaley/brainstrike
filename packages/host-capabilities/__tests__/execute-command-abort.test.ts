/**
 * A stopped command ends at once: an abort kills its whole group without a SIGTERM grace.
 */
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runDetachedProcess, type SpawnOutcome } from '../src/native-tools/execute-command-tool.ts';
import { packageWindowsCommandEntry } from './fixtures/execute-command.ts';

const IGNORE_SIGTERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6);";

afterEach(() => {
  vi.useRealTimers();
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
});
