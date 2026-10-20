import { registerClosePreparation } from '@brainstrike/file-explorer-hooks';
import { expect, it, vi } from 'vitest';

function registry() {
  const participants = new Set<() => Promise<void>>();
  return {
    participants,
    register: (prepare: () => Promise<void>) => {
      participants.add(prepare);
      return () => {
        participants.delete(prepare);
      };
    },
  };
}

it('retains a detached rejection that races the terminal close callback', async () => {
  const r = registry();
  const ack = Promise.withResolvers<void>();
  const failure = new Error('controlled racing write failure');
  const detach = registerClosePreparation(
    { drain: () => ack.promise, prepareClose: async () => {} },
    r.register
  );
  detach();
  ack.reject(failure);
  const participant = [...r.participants][0];
  if (!participant) {
    throw new Error('Detached owner registration was discarded');
  }
  await expect(participant()).rejects.toBe(failure);
});

it('keeps a detached owner registered while its admitted write is pending', async () => {
  const r = registry();
  const ack = Promise.withResolvers<void>();
  const prepare = vi.fn(() => ack.promise);
  const detach = registerClosePreparation(
    { drain: () => ack.promise, prepareClose: prepare },
    r.register
  );
  detach();
  expect(r.participants.size).toBe(1);
  const closing = Promise.all([...r.participants].map((prepare) => prepare()));
  expect(prepare).toHaveBeenCalledOnce();
  ack.resolve();
  await closing;
  expect(r.participants.size).toBe(0);
});

it('StrictMode setup/cleanup/setup does not prepare the store or delete its new registration', async () => {
  const r = registry();
  const ack = Promise.withResolvers<void>();
  const prepare = vi.fn(async () => {});
  const owner = { drain: () => ack.promise, prepareClose: prepare };
  const oldDetach = registerClosePreparation(owner, r.register);
  oldDetach();
  registerClosePreparation(owner, r.register);
  expect(prepare).not.toHaveBeenCalled();
  expect(r.participants.size).toBe(2);
  ack.resolve();
  await ack.promise;
  expect(r.participants.size).toBe(1);
  await Promise.all([...r.participants].map((prepare) => prepare()));
  expect(prepare).toHaveBeenCalledOnce();
});

it('replacement retains the old failed owner and its original rejection', async () => {
  const r = registry();
  const ack = Promise.withResolvers<void>();
  const failure = new Error('controlled old owner failure');
  const detach = registerClosePreparation(
    { drain: () => ack.promise, prepareClose: async () => {} },
    r.register
  );
  detach();
  registerClosePreparation({ drain: async () => {}, prepareClose: async () => {} }, r.register);
  ack.reject(failure);
  await ack.promise.catch(() => undefined);
  const results = await Promise.allSettled([...r.participants].map((prepare) => prepare()));
  expect(results).toContainEqual({ reason: failure, status: 'rejected' });
  expect(results).toContainEqual({ status: 'fulfilled', value: undefined });
});
