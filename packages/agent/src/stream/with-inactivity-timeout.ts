export class StreamStalledError extends Error {
  readonly code = 'stream_inactivity_timeout';
  constructor(public readonly inactivityMs: number) {
    super(`Stream produced no output for ${inactivityMs}ms`);
    this.name = 'StreamStalledError';
  }
}

/**
 * Wrap an async iterable so that a gap longer than `inactivityMs` between items
 * throws {@link StreamStalledError}. The timer resets on every delivered item.
 * Used around the raw Mastra stream so a wedged provider/tool can never freeze
 * the data-stream session forever.
 */
export async function* withInactivityTimeout<T>(
  source: AsyncIterable<T>,
  inactivityMs: number
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watchdog = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StreamStalledError(inactivityMs)), inactivityMs);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        const result = await Promise.race([iterator.next(), watchdog]);
        if (result.done) {
          return;
        }
        yield result.value;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }
  } finally {
    // Signal cleanup to the source iterator. We do NOT await the return()
    // promise because, if the source is suspended on a never-resolving await,
    // an awaited return() deadlocks. Calling without await is sufficient to
    // signal the generator to run its own finally blocks when it next resumes.
    iterator.return?.();
  }
}
