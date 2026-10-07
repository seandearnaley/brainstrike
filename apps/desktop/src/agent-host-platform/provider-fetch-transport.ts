import { Buffer } from 'node:buffer';
import {
  type CancellationToken,
  type MessageConnection,
  type ProgressToken,
  ProgressType,
} from 'vscode-jsonrpc/node';
import { z } from 'zod';

const Scope = z.strictObject({ provider: z.string().min(1), threadId: z.string().min(1) });
const Address = Scope.extend({ progressToken: z.union([z.string(), z.number().int()]) });
const FetchRequest = Address.extend({
  body: z.string().optional(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  method: z.string(),
  url: z.url(),
});
const Metadata = z.strictObject({
  hasBody: z.boolean(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  status: z.number().int().min(200).max(599),
  statusText: z.string(),
});
const Chunk = z.strictObject({ bytes: z.string() });
const progress = new ProgressType<z.infer<typeof Chunk>>();
const nextToken = new WeakMap<MessageConnection, number>();
const method = 'platform/provider-fetch';

export type ProviderFetchScope = z.infer<typeof Scope>;

interface FetchTail {
  readonly controller: AbortController;
  readonly fetch: typeof globalThis.fetch;
  joined?: Promise<void>;
  readonly original: Promise<Response>;
  read?: Promise<ReadableStreamReadResult<Uint8Array>>;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  readonly scope: ProviderFetchScope;
}

async function joinAll(tasks: readonly Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(tasks);
  const errors = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, 'Provider fetch cleanup failed');
  }
}

/** Borrows the existing admitted Main auth closure; owns only this connection's fetch tails. */
export function serveProviderFetchTransport(
  connection: MessageConnection,
  options: { getFetch(scope: ProviderFetchScope): typeof globalThis.fetch }
): { close(): Promise<void>; release(threadId: string): Promise<void> } {
  const active = new Map<ProgressToken, FetchTail>();
  const releasing = new Map<string, Promise<void>>();
  let closing: Promise<void> | undefined;
  const join = (token: ProgressToken, tail: FetchTail, cancel: boolean): Promise<void> => {
    if (cancel) {
      tail.controller.abort(new Error('Provider fetch cancelled'));
    }
    tail.joined ??= (async () => {
      // The original fetch may ignore abort. Retain its closure until it actually
      // settles, then join cancellation of any response body it produced.
      await tail.original.catch(() => undefined);
      if (cancel && tail.reader) {
        await joinAll([
          tail.reader.cancel(tail.controller.signal.reason),
          ...(tail.read ? [tail.read] : []),
        ]);
      }
      tail.reader?.releaseLock();
    })().finally(() => active.delete(token));
    return tail.joined;
  };
  const lookup = (input: unknown): [ProgressToken, FetchTail] => {
    const address = Address.parse(input);
    const tail = active.get(address.progressToken);
    if (
      !tail ||
      tail.scope.threadId !== address.threadId ||
      tail.scope.provider !== address.provider
    ) {
      throw new Error('Provider fetch is not admitted for this scope');
    }
    return [address.progressToken, tail];
  };
  const handlers = [
    connection.onRequest(method, async (input: unknown, cancellation: CancellationToken) => {
      const request = FetchRequest.parse(input);
      if (closing || releasing.has(request.threadId)) {
        throw new Error('Provider fetch scope is closing');
      }
      if (active.has(request.progressToken)) {
        throw new Error('Provider fetch progress token is already in use');
      }
      const scope = { provider: request.provider, threadId: request.threadId };
      const capturedFetch = options.getFetch(scope);
      const controller = new AbortController();
      const tail: FetchTail = {
        controller,
        fetch: capturedFetch,
        original: Promise.resolve().then(async () => {
          const response = await tail.fetch(request.url, {
            ...(request.body === undefined ? {} : { body: request.body }),
            headers: request.headers,
            method: request.method,
            signal: controller.signal,
          });
          tail.reader = response.body?.getReader();
          return response;
        }),
        scope,
      };
      active.set(request.progressToken, tail);
      const cancel = (): void => {
        void join(request.progressToken, tail, true).catch(() => undefined);
      };
      const subscription = cancellation.onCancellationRequested(cancel);
      if (cancellation.isCancellationRequested) {
        cancel();
      }
      try {
        const response = await tail.original;
        controller.signal.throwIfAborted();
        const metadata = Metadata.parse({
          hasBody: response.body !== null,
          headers: [...response.headers],
          status: response.status,
          statusText: response.statusText,
        });
        if (!tail.reader) {
          await join(request.progressToken, tail, false);
        }
        return metadata;
      } catch (cause) {
        await join(request.progressToken, tail, true);
        throw cause;
      } finally {
        subscription.dispose();
      }
    }),
    connection.onRequest(`${method}/read`, async (input: unknown) => {
      const [token, tail] = lookup(input);
      tail.controller.signal.throwIfAborted();
      if (!tail.reader || tail.read) {
        throw new Error('Provider fetch body is not available for another read');
      }
      tail.read = tail.reader.read();
      try {
        const result = await tail.read;
        tail.controller.signal.throwIfAborted();
        if (result.done) {
          await join(token, tail, false);
        } else {
          await connection.sendProgress(progress, token, {
            bytes: Buffer.from(result.value).toString('base64'),
          });
        }
        return { done: result.done };
      } catch (cause) {
        await join(token, tail, true);
        throw cause;
      } finally {
        tail.read = undefined;
      }
    }),
    connection.onRequest(`${method}/cancel`, async (input: unknown) => {
      const address = Address.parse(input);
      // Completion and a client's final abort can cross on the private port.
      if (active.has(address.progressToken)) {
        const [token, tail] = lookup(input);
        await join(token, tail, true);
      }
    }),
  ];
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const handler of handlers) {
        handler.dispose();
      }
      for (const subscription of lifecycle) {
        subscription.dispose();
      }
      await joinAll([...active].map(([token, tail]) => join(token, tail, true)));
    })();
    return closing;
  };
  // The caller still awaits close() after transport loss; disposal is no join.
  const lifecycle = [
    connection.onClose(() => void close().catch(() => undefined)),
    connection.onDispose(() => void close().catch(() => undefined)),
  ];
  return {
    close,
    release: (threadId) => {
      let task = releasing.get(threadId);
      if (!task) {
        task = joinAll(
          [...active]
            .filter(([, tail]) => tail.scope.threadId === threadId)
            .map(([token, tail]) => join(token, tail, true))
        ).finally(() => releasing.delete(threadId));
        releasing.set(threadId, task);
      }
      return task;
    },
  };
}

/** SDK JSON requests use the private capability port, never a serialized credential. */
export function createProviderFetchTransport(
  connection: MessageConnection,
  admitted: ProviderFetchScope
): { close(): Promise<void>; fetch: typeof globalThis.fetch } {
  const scope = Scope.parse(admitted);
  const pending = new Set<() => Promise<void>>();
  let closing: Promise<void> | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (closing) {
      throw new Error('Provider fetch scope is closing');
    }
    if (
      input instanceof Request ||
      (init?.body !== undefined && init.body !== null && typeof init.body !== 'string')
    ) {
      throw new TypeError('Provider transport requires the SDK URL and string body request shape');
    }
    init?.signal?.throwIfAborted();
    const token = (nextToken.get(connection) ?? 0) + 1;
    nextToken.set(connection, token);
    const address = { ...scope, progressToken: token };
    let bytes: Uint8Array | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled: Promise<void> | undefined;
    let retired = false;
    const dispose = (): void => {
      if (retired) {
        return;
      }
      retired = true;
      listener.dispose();
      init?.signal?.removeEventListener('abort', abort);
      pending.delete(cancel);
    };
    const cancel = (): Promise<void> => {
      cancelled ??= Promise.resolve()
        .then(() => connection.sendRequest<void>(`${method}/cancel`, address))
        .finally(dispose);
      return cancelled;
    };
    const abort = (): void => {
      void cancel().then(
        () => controller?.error(init?.signal?.reason),
        (cause: unknown) => controller?.error(cause)
      );
    };
    const listener = connection.onProgress(progress, token, (value) => {
      bytes = new Uint8Array(Buffer.from(Chunk.parse(value).bytes, 'base64'));
    });
    pending.add(cancel);
    init?.signal?.addEventListener('abort', abort, { once: true });
    try {
      const metadata = Metadata.parse(
        await connection.sendRequest<unknown>(method, {
          ...address,
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
          headers: [...new Headers(init?.headers)],
          method: init?.method ?? 'GET',
          url: input.toString(),
        })
      );
      if (cancelled) {
        await cancelled;
        init?.signal?.throwIfAborted();
        throw new Error('Provider fetch scope closed during request');
      }
      if (!metadata.hasBody) {
        dispose();
        return new Response(null, metadata);
      }
      const body = new ReadableStream<Uint8Array>(
        {
          cancel,
          pull: async (target) => {
            try {
              bytes = undefined;
              const result = z
                .strictObject({ done: z.boolean() })
                .parse(await connection.sendRequest<unknown>(`${method}/read`, address));
              if (result.done) {
                target.close();
                dispose();
              } else if (bytes) {
                target.enqueue(bytes);
              } else {
                throw new Error('Provider response body progress was missing');
              }
            } catch (cause) {
              target.error(cause);
              await cancel();
            }
          },
          start: (target) => {
            controller = target;
          },
        },
        { highWaterMark: 0 }
      );
      return new Response(body, metadata);
    } catch (cause) {
      await cancel();
      throw cause;
    }
  };
  return {
    close: () => (closing ??= joinAll([...pending].map((cancel) => cancel()))),
    fetch,
  };
}
