import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('ReadableStreamIterator');

export async function* readableStreamIterator<T>(
  stream: NodeReadableStream<T> | ReadableStream<T>,
  signal?: AbortSignal
): AsyncIterableIterator<T> {
  const webStream = stream as ReadableStream<T>;
  const reader = webStream.getReader();

  const abortPromise = signal
    ? new Promise<{ done: true; value: undefined }>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve({ done: true, value: undefined });
          },
          { once: true }
        );
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
    try {
      reader.cancel();
    } catch (cancelError) {
      // Stream reader cancel errors during cleanup are non-critical
      // but logged for debugging silent failures
      if (cancelError instanceof Error) {
        logger.warn('Stream reader cancel failed', { error: cancelError.message });
      }
    }
    reader.releaseLock();
  }
}
