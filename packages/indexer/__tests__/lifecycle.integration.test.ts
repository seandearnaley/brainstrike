import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalRoot } from '@brainstrike/state-store';
import { afterEach, describe, expect, it } from 'vitest';
import type * as Transport from '../src/transport.js';

// The transport forks the process entry beside its own module, so this suite
// drives the built transport; the source owns its type.
const { createIndexerConnection }: typeof Transport = await import(
  new URL('../src/transport.ts', import.meta.url).href
);

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});
async function fixture(killMode: 'real' | 'refuse' | 'throw') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-indexer-lifecycle-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const entry = path.join(directory, 'never-ready.cjs');
  await writeFile(
    entry,
    "process.on('message', () => {}); process.on('disconnect', () => process.exit());"
  );
  const child = fork(entry, [], {
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await exited;
  });
  let attempts = 0;
  const permitted = killMode === 'real';
  const connection = createIndexerConnection(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      stateProjection: {
        mode: 'dev',
        module: new URL('./fixtures/state-schema.mjs', import.meta.url).href,
      },
      stateRoot: canonicalRoot(directory),
    },
    { closeMs: 100 },
    {
      kill: () => {
        attempts += 1;
        if (permitted) {
          return child.kill();
        }
        if (killMode === 'throw') {
          throw new Error('injected termination refusal');
        }
        return false;
      },
      onError: (listener) => {
        child.on('error', listener);
        return () => child.off('error', listener);
      },
      onExit: (listener) => {
        child.on('exit', listener);
        return () => child.off('exit', listener);
      },
      onMessage: (listener) => {
        child.on('message', listener);
        return () => child.off('message', listener);
      },
      send: (message) => child.send(message),
    }
  );
  return {
    attempts: () => attempts,
    child,
    connection,
  };
}
describe('real process close ladder ownership', () => {
  // Lifecycle R2/R3: no clock retires a process that has not reported ready; close is
  // what ends it, escalating its unanswered cooperative close to one kill whose exit is
  // joined (R5(b)). The escalation is not a failure; a refused kill is.
  it('waits for a never-ready process, then close joins a single confirmed termination', async () => {
    const host = await fixture('real');
    const ready = host.connection.ready.catch((failure: unknown) => failure);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(host.connection.exited).toBe(false);
    expect(host.attempts()).toBe(0);
    await expect(host.connection.close()).resolves.toBeUndefined();
    expect(await ready).toBeInstanceOf(Error);
    expect(host.connection.exited).toBe(true);
    expect(host.attempts()).toBe(1);
    expect(() => process.kill(host.child.pid!, 0)).toThrow();
    await host.connection.close();
    expect(host.attempts()).toBe(1);
  });
  // ADR-0030: a kill is a request. Windows refuses to terminate a process that is already
  // exiting, so a refused or failing kill is logged, never a fault: the process stays owned and
  // close ends at its exit, with no second kill.
  for (const mode of ['refuse', 'throw'] as const) {
    it(`keeps joining the exit after a kill ${mode}, and close resolves when the process exits`, async () => {
      const host = await fixture(mode);
      // Close ends the never-ready startup; that startup's own rejection is not this test's.
      host.connection.ready.catch(() => undefined);
      let settled = false;
      const closing = host.connection.close().finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      expect(host.connection.exited).toBe(false);
      expect(host.attempts()).toBe(1);
      expect(() => process.kill(host.child.pid!, 0)).not.toThrow();
      // The process finishes exiting on its own (its fixture exits when its channel closes).
      host.child.disconnect();
      await expect(closing).resolves.toBeUndefined();
      expect(host.connection.exited).toBe(true);
      expect(host.attempts()).toBe(1);
    });
  }
});
