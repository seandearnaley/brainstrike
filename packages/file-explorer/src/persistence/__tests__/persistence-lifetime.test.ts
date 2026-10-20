import { expect, it, vi } from 'vitest';
import { PersistenceLifetime } from '../persistence-lifetime';

it('joins admitted writes, fences new calls and returns one preparation promise', async () => {
  const ack = Promise.withResolvers<void>();
  const lifetime = new PersistenceLifetime(async () => {});
  const saved = lifetime.run(() => ack.promise);
  let closed = false;
  const preparing = lifetime.prepareClose();
  void preparing.then(() => {
    closed = true;
  });
  expect(lifetime.prepareClose()).toBe(preparing);
  await expect(lifetime.run(async () => {})).rejects.toThrow('preparing to close');
  expect(closed).toBe(false);
  ack.resolve();
  await Promise.all([saved, preparing]);
  expect(closed).toBe(true);
});

it('flushes a write admitted before prepare that was still waiting on a read', async () => {
  const read = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  let writing = false;
  const flush = vi.fn(async () => {
    if (writing) {
      await ack.promise;
    }
  });
  const lifetime = new PersistenceLifetime(flush);
  const saved = lifetime.run(async () => {
    await read.promise;
    writing = true;
    await lifetime.joinWrite(ack.promise);
  });
  let closed = false;
  const preparing = lifetime.prepareClose().then(() => {
    closed = true;
  });
  read.resolve();
  await vi.waitFor(() => expect(writing).toBe(true));
  expect(closed).toBe(false);
  ack.resolve();
  await Promise.all([saved, preparing]);
  expect(flush.mock.calls.length).toBeGreaterThan(1);
});

it('retains the original rejection through the close join', async () => {
  const ack = Promise.withResolvers<void>();
  const failure = new Error('controlled adapter failure');
  const lifetime = new PersistenceLifetime(async () => {});
  const saved = lifetime.run(() => ack.promise);
  const savingFailure = expect(saved).rejects.toBe(failure);
  const preparing = lifetime.prepareClose();
  const closingFailure = expect(preparing).rejects.toBe(failure);
  ack.reject(failure);
  await Promise.all([savingFailure, closingFailure]);
  expect(lifetime.prepareClose()).toBe(preparing);
});

it('a detached registration can drain without terminal-fencing a live store', async () => {
  const ack = Promise.withResolvers<void>();
  const lifetime = new PersistenceLifetime(async () => {});
  const first = lifetime.run(() => ack.promise);
  const draining = lifetime.drain();
  const second = lifetime.run(async () => {});
  await second;
  ack.resolve();
  await Promise.all([first, draining]);
  await expect(lifetime.run(async () => {})).resolves.toBeUndefined();
});

it('a synchronous adapter failure remains an observable rejected operation', async () => {
  const failure = new Error('sync failure');
  const lifetime = new PersistenceLifetime(async () => {});
  await expect(
    lifetime.run(() => {
      throw failure;
    })
  ).rejects.toBe(failure);
});
