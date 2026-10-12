import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { RootLock, RootLockedError } from '../src/lock.js';
import { StateStore } from '../src/state-store.js';

async function writerFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-writer-retirement-')));
  const store = await StateStore.open(root);
  const owned: unknown = Object.getOwnPropertyDescriptor(store, 'worker')?.value;
  if (!(owned instanceof Worker)) {
    throw new Error('Actual canonical writer was not acquired');
  }
  const terminate = owned.terminate.bind(owned);
  return { root, store, terminate, writer: owned };
}

test('every close caller waits the same physical writer join before Root release', async () => {
  const f = await writerFixture();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let terminations = 0;
  f.writer.terminate = async () => {
    terminations += 1;
    entered.resolve();
    await released.promise;
    return f.terminate();
  };
  const closing = f.store.close();
  try {
    await entered.promise;
    let repeatedSettled = false;
    const repeated = f.store.close().then(() => {
      repeatedSettled = true;
    });
    await Promise.resolve();
    expect(repeatedSettled).toBe(false);
    expect(f.writer.threadId).toBeGreaterThan(0);
    expect(RootLock.inspect(f.root)?.owner.released).not.toBe(true);
    await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);
    released.resolve();
    await Promise.all([closing, repeated]);
    expect(terminations).toBe(1);
    expect(f.writer.threadId).toBe(-1);
    expect(RootLock.inspect(f.root)?.owner.released).toBe(true);
  } finally {
    released.resolve();
    await closing;
    await rm(f.root, { force: true, recursive: true });
  }
});

test('a rejected termination retains the live writer and Root and repeats the original failure', async () => {
  const f = await writerFixture();
  const failure = new Error('Synthetic Worker termination rejection');
  let terminations = 0;
  f.writer.terminate = async () => {
    terminations += 1;
    throw failure;
  };
  try {
    await expect(f.store.close()).rejects.toBe(failure);
    expect(f.writer.threadId).toBeGreaterThan(0);
    expect(RootLock.inspect(f.root)?.owner.released).not.toBe(true);
    await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);
    await expect(f.store.close()).rejects.toBe(failure);
    expect(terminations).toBe(1);
  } finally {
    // The fixture alone owns this injected failed join. Physically terminate
    // its real writer before explicitly retiring the retained fixture lock.
    await f.terminate();
    expect(f.writer.threadId).toBe(-1);
    if (!f.store.lock.isReleased) {
      f.store.lock.release();
    }
    await rm(f.root, { force: true, recursive: true });
  }
});

test('independent database and termination failures both survive the joined close', async () => {
  const f = await writerFixture();
  const database = new Error('Synthetic independent writer error');
  const termination = new Error('Synthetic independent termination error');
  f.writer.emit('error', database);
  f.writer.terminate = async () => {
    throw termination;
  };
  try {
    const failure = await f.store.close().catch((cause: unknown) => cause);
    if (!(failure instanceof AggregateError)) {
      throw new Error('Both independent close causes must be retained');
    }
    const members: readonly unknown[] = failure.errors;
    expect(members).toContain(termination);
    expect(members.some((member) => member instanceof Error && member.cause === database)).toBe(
      true
    );
    expect(f.writer.threadId).toBeGreaterThan(0);
    expect(RootLock.inspect(f.root)?.owner.released).not.toBe(true);
    await expect(f.store.close()).rejects.toBe(failure);
  } finally {
    await f.terminate();
    expect(f.writer.threadId).toBe(-1);
    f.store.lock.release();
    await rm(f.root, { force: true, recursive: true });
  }
});
