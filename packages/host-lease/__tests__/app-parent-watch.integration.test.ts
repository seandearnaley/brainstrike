// "A host forked by the app dies with the app" (ADR-0017). The host learns that from its lifetime
// channel, so an idle app host starts no process to watch its app: a former 100 ms poll ran a
// synchronous `ps` each tick and blocked the agent host's event loop for 8% of a profiled window.
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processStartTime } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { startHost } from '../src/runtime.js';

const childProcess = createRequire(import.meta.url)(
  'node:child_process'
) as typeof import('node:child_process');

test('an idle app host starts no process to watch its app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-parent-watch-'));
  // This process is the host; its real OS parent plays the app.
  const start = processStartTime(process.ppid);
  if (start === null) {
    throw new Error('The test process has no live parent');
  }
  const host = await startHost({
    lifetime: 'app',
    parent: { pid: process.ppid, start },
    root,
    startupGraceMs: 60_000,
  });
  const spawned: string[] = [];
  const original = childProcess.execFileSync;
  childProcess.execFileSync = ((file: string, ...rest: never[]) => {
    spawned.push(file);
    return original(file, ...rest);
  }) as typeof childProcess.execFileSync;
  syncBuiltinESMExports();
  try {
    // At least five ticks of the 100 ms poll.
    await delay(550);
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
  expect(spawned).toEqual([]);
});
