/**
 * ADR-0017: a native process a host starts never outlives the host's hold on its
 * Root. A POSIX command inherits the Root's flock, so it keeps the Root refused
 * until it exits; a Windows host's kill-on-close Job ends the command with the
 * host. Either way, after the host dies a new owner takes the Root only once
 * every native process that host started is gone.
 */
import { type ChildProcess, spawn } from 'node:child_process';
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
const decodeStarted = makeThrowingDecoder(Schema.Struct({ command: Identity, host: Identity }));
const running = (identity: Identity): boolean => processStartTime(identity.pid) === identity.start;
/** Ends a process only while its identity is still its own, so a reused pid is never signalled. */
const end = (identity: Identity): void => {
  if (running(identity)) {
    process.kill(identity.pid, 'SIGKILL');
  }
};

const roots: string[] = [];
const hosts: ChildProcess[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    if (host.exitCode === null && host.signalCode === null) {
      const exited = once(host, 'exit');
      host.kill('SIGKILL');
      await exited;
    }
    // Closing the lifeline ends every native process the host started, recorded or not.
    host.stdio[3]?.destroy();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('after its host dies, a Root is refused until every native process the host started is gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-native-tail-'));
  roots.push(root);
  const host = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./fixtures/native-tail-host.ts', import.meta.url)),
      root,
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      detached: true,
      // fd 3 is the lifeline: the host and its command end when this process lets it go or dies.
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  hosts.push(host);
  const [, stdout, stderr] = host.stdio;
  if (!(stdout && stderr)) {
    throw new Error('The host has no output pipes');
  }
  let errors = '';
  stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const lines = createInterface({ input: stdout });
  const line = (await lines[Symbol.asyncIterator]().next()).value;
  lines.close();
  if (typeof line !== 'string') {
    throw new Error(`The host reported no process identities: ${errors}`);
  }
  const { command, host: owner } = decodeStarted(JSON.parse(line));
  expect(running(command)).toBe(true);

  const exited = once(host, 'exit');
  host.kill('SIGKILL');
  await exited;
  expect(running(owner)).toBe(false);

  const refusal = await RootLock.acquire(root).then(
    (lock) => {
      lock.release();
      return;
    },
    (cause: unknown) => cause
  );
  if (refusal === undefined) {
    // The Root was free: the command must have ended with its host.
    await expect.poll(() => running(command), { timeout: 5000 }).toBe(false);
  } else {
    // The Root was refused: the command that still runs holds it, naming its host.
    expect(refusal).toBeInstanceOf(RootLockedError);
    expect(refusal).toMatchObject({ holder: 'native-tail', owner: { pid: owner.pid } });
    expect(running(command)).toBe(true);
  }

  end(command);
  await expect.poll(() => running(command), { timeout: 5000 }).toBe(false);
  const next = await RootLock.acquire(root);
  next.release();
});
