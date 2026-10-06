import { MessageChannel, Worker } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { createKeyringNativeBackend } from '../src/adapters/keyring-native-worker.js';

test('credential backend joins a held native completion before its owned worker exits', async () => {
  let worker: Worker | undefined;
  const entered = Promise.withResolvers<void>();
  const observed = new MessageChannel();
  observed.port1.once('message', () => entered.resolve());
  const backend = createKeyringNativeBackend('owned-fixture-service', {
    createWorker: (_entry, options) => {
      worker = new Worker(new URL('./fixtures/keyring-native-worker.mjs', import.meta.url), {
        ...options,
        transferList: [observed.port2],
        workerData: { observationPort: observed.port2, service: 'owned-fixture-service' },
      });
      return worker;
    },
  });
  try {
    await backend.write('openai', 'fixture credential');
    expect(await backend.listAccounts()).toEqual(['openai']);
    expect(await backend.read('openai')).toBe('fixture credential');
    const held = backend.read('held-native-call');
    await entered.promise;
    let closed = false;
    const close = backend.close().then(() => {
      closed = true;
    });
    await expect(backend.write('late-write', 'rejected')).rejects.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(worker?.threadId).not.toBe(-1);
    worker?.postMessage({ release: true });
    expect(await held).toBe('held result');
    await close;
    expect(worker?.threadId).toBe(-1);
    expect(await backend.close()).toBeUndefined();
  } finally {
    worker?.postMessage({ release: true });
    await backend.close();
    observed.port1.close();
  }
});
