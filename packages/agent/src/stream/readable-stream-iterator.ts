import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('ReadableStreamIterator');

export async function* readableStreamIterator<T>(
  stream: NodeReadableStream<T> | ReadableStream<T>,
  signal?: AbortSignal
): AsyncIterableIterator<T> {
  const webStream = stream as ReadableStream<T>;
  const reader = webStream.getReader();

  let abortHandler: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<{ done: true; value: undefined }>((resolve) => {
        abortHandler = () => {
          resolve({ done: true, value: undefined });
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      })
    : new Promise<never>(() => {});

  try {
    while (true) {
      if (signal?.aborted) {
        break;
      }
      const readPromise = reader.read();
      const result = await Promise.race([readPromise, abortPromise]);

      if (result.done) {
        break;
      }
      if (result.value !== undefined) {
        yield result.value as T;
      }
    }
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
    // `cancel()` returns a PROMISE, and on an ERRORED stream it rejects with
    // the stream's stored error. A try/catch only catches synchronous throws,
    // so every errored stream — i.e. every provider transport failure — used to
    // leave a dangling rejection behind, which is noise at best, fatal at worst
    // depending on host config, and buries the real error either way.
    //
    // Deliberately NOT awaited: the consumer has already seen the outcome, and
    // awaiting a cancel against a stalled source would hang the cleanup. Same
    // reasoning as the un-awaited `iterator.return?.()` in
    // with-inactivity-timeout.ts.
    reader.cancel().catch((cancelError: unknown) => {
      if (cancelError instanceof Error) {
        logger.warn('Stream reader cancel failed', { error: cancelError.message });
      }
    });
    reader.releaseLock();
  }
}
