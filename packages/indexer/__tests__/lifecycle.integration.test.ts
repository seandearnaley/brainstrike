import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIndexerConnection, IndexerLifecycleError } from '../dist/transport.js';

const profile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
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
  let permitted = killMode === 'real';
  const connection = createIndexerConnection(
    { dbPath: path.join(directory, 'index.sqlite'), profile, rootIds: ['root-a'] },
    { closeMs: 100, exitMs: 100, requestMs: 100, startupMs: 100 },
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
    allowKill: () => {
      permitted = true;
    },
    attempts: () => attempts,
    child,
    connection,
  };
}
describe('real process deadline ownership', () => {
  it('bounds startup and joins a single confirmed termination', async () => {
    const host = await fixture('real');
    await expect(host.connection.ready).rejects.toThrow('startup exceeded');
    expect(host.connection.exited).toBe(true);
    expect(host.attempts()).toBe(1);
    expect(() => process.kill(host.child.pid!, 0)).toThrow();
    await host.connection.close();
    expect(host.attempts()).toBe(1);
  });
  for (const mode of ['refuse', 'throw'] as const) {
    it(`retains live ownership after kill ${mode} and allows explicit joined cleanup`, async () => {
      const host = await fixture(mode);
      const error = await host.connection.ready.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(IndexerLifecycleError);
      expect(host.connection.exited).toBe(false);
      expect(host.attempts()).toBe(1);
      expect(() => process.kill(host.child.pid!, 0)).not.toThrow();
      host.allowKill();
      await expect(host.connection.close()).rejects.toThrow('close failed');
      expect(host.connection.exited).toBe(true);
      expect(host.attempts()).toBe(2);
      await host.connection.close();
      expect(host.attempts()).toBe(2);
    });
  }
});
