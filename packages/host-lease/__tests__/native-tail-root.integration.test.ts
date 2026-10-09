import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { processStartTime, RootLock, RootLockedError } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';

const Identity = Schema.Struct({ pid: Schema.Int, start: Schema.String });
type Identity = typeof Identity.Type;
const decodeReady = makeThrowingDecoder(Schema.Struct({ command: Identity, host: Identity }));
const fixture = fileURLToPath(new URL('./fixtures/native-tail-host.ts', import.meta.url));
const roots: string[] = [];
const owned: Identity[] = [];

async function waitForGone({ pid, start }: Identity): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (processStartTime(pid) !== start) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Owned process ${pid} did not exit`);
}

afterEach(async () => {
  // Every identity here was started by this test; a survivor is killed only while its start time still matches.
  for (const identity of owned.splice(0)) {
    if (processStartTime(identity.pid) === identity.start) {
      process.kill(identity.pid, 'SIGKILL');
      await waitForGone(identity);
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

// The ordinary desktop utility-loss case at its lease: the agent host holds Root and has started a
// native command when it dies. Until that command exits, a second writer on the same Root is refused;
// once it has, the stale record is taken over. Windows ends the command with the host's Job Object.
test.skipIf(process.platform === 'win32')(
  "a crashed Root holder's surviving native command keeps the Root refused until it exits",
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-native-tail-'));
    roots.push(root);
    const holder = fork(fixture, [root], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    if (!holder.stdout) {
      throw new Error('The Root holder fixture has no stdout');
    }
    const [line] = await once(createInterface({ input: holder.stdout }), 'line');
    const ready = decodeReady(JSON.parse(String(line)));
    owned.push(ready.command, ready.host);
    expect(RootLock.inspect(root)?.owner).toMatchObject(ready.host);

    process.kill(ready.host.pid, 'SIGKILL');
    await waitForGone(ready.host);
    expect(processStartTime(ready.command.pid)).toBe(ready.command.start);

    let contender: RootLock | undefined;
    let refusal: unknown;
    try {
      contender = await RootLock.acquire(root);
    } catch (cause) {
      refusal = cause;
    }
    contender?.release();
    expect(processStartTime(ready.command.pid)).toBe(ready.command.start);
    expect(refusal).toBeInstanceOf(RootLockedError);
    expect(refusal).toMatchObject({ holder: 'native-tail', owner: ready.host });
    expect(RootLock.inspect(root)?.owner).toMatchObject(ready.host);

    process.kill(ready.command.pid, 'SIGKILL');
    await waitForGone(ready.command);
    const broken: unknown[] = [];
    const next = await RootLock.acquire(root, { onStaleBroken: (owner) => broken.push(owner) });
    next.release();
    expect(broken).toEqual([expect.objectContaining(ready.host)]);
  }
);
