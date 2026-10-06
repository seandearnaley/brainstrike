import { Worker, type WorkerOptions } from 'node:worker_threads';
import { z } from 'zod';
import {
  type KeyringNativeBackend,
  type KeyringNativeRequest,
  KeyringNativeResponseSchema,
} from './keyring-native-protocol.js';

export type { KeyringNativeBackend } from './keyring-native-protocol.js';

export interface KeyringNativeWorkerOptions {
  /** Trusted fixture/composition seam; never accepted through the client protocol. */
  readonly createWorker?: (entry: URL, options: WorkerOptions) => Worker;
}

/** One retained worker per root credential owner; closing never terminates native work. */
export function createKeyringNativeBackend(
  service: string,
  options: KeyringNativeWorkerOptions = {}
): KeyringNativeBackend {
  z.string().min(1).parse(service);
  const worker = (
    options.createWorker ?? ((entry, workerOptions) => new Worker(entry, workerOptions))
  )(new URL('./keyring-native-entry.js', import.meta.url), { workerData: { service } });
  type Value = Extract<z.infer<typeof KeyringNativeResponseSchema>, { ok: true }>['value'];
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Value>>>();
  const exited = Promise.withResolvers<void>();
  let nextId = 0;
  let closing: Promise<void> | undefined;
  let failure: Error | undefined;
  exited.promise.catch(() => undefined);
  const fail = (): void => {
    failure ??= new Error('Credential native worker failed');
    for (const operation of pending.values()) {
      operation.reject(failure);
    }
    pending.clear();
  };
  worker.on('error', fail);
  worker.once('exit', (code) => {
    if (code !== 0 || pending.size > 0 || !closing) {
      fail();
    }
    if (failure) {
      exited.reject(failure);
    } else {
      exited.resolve();
    }
  });
  worker.on('message', (input: unknown) => {
    const parsed = KeyringNativeResponseSchema.safeParse(input);
    if (!parsed.success) {
      fail();
      return;
    }
    const response = parsed.data;
    const operation = pending.get(response.id);
    if (!operation) {
      fail();
      return;
    }
    pending.delete(response.id);
    if (response.ok) {
      operation.resolve(response.value);
    } else {
      operation.reject(new Error('OS credential operation failed'));
    }
  });
  type Input = KeyringNativeRequest extends infer Request
    ? Request extends KeyringNativeRequest
      ? Omit<Request, 'id'>
      : never
    : never;
  const perform = (input: Input): Promise<Value> => {
    if (failure) {
      return Promise.reject(failure);
    }
    if (closing && input.operation !== 'close') {
      return Promise.reject(new Error('Credential native worker is closing'));
    }
    const id = ++nextId;
    const operation = Promise.withResolvers<Value>();
    pending.set(id, operation);
    try {
      worker.postMessage({ ...input, id });
    } catch {
      pending.delete(id);
      operation.reject(new Error('Credential native worker transport failed'));
    }
    return operation.promise;
  };
  return {
    close: () => {
      closing ??= Promise.resolve().then(async () => {
        await Promise.allSettled([...pending.values()].map((operation) => operation.promise));
        if (!failure) {
          await perform({ operation: 'close' });
        }
        await exited.promise;
      });
      return closing;
    },
    delete: async (account) => z.boolean().parse(await perform({ account, operation: 'delete' })),
    listAccounts: async () =>
      z.array(z.string()).parse(await perform({ operation: 'listAccounts' })),
    read: async (account) =>
      z
        .string()
        .nullable()
        .parse(await perform({ account, operation: 'read' })) ?? undefined,
    write: async (account, value) => {
      z.null().parse(await perform({ account, operation: 'write', value }));
    },
  };
}
