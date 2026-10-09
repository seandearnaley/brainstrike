import { type LanguageModel, wrapLanguageModel } from 'ai';

/**
 * BST-1932 (C4): one FIFO queue of active model/tool work shared by every
 * descendant of a root turn, sized by `maxConcurrentWork`. Ported from the
 * shipped DelegatedWorkQueue (packages/agent/src/mastra/delegated-work-budget.ts,
 * removed with BST-1935). A waiter whose signal aborts leaves the queue, and a
 * delegation or approval wait holds no permit.
 */
export class HostChildWorkQueue {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly maxConcurrentWork: number) {
    if (!Number.isInteger(maxConcurrentWork) || maxConcurrentWork < 1) {
      throw new Error(
        `Delegated work concurrency must be a positive integer; received ${maxConcurrentWork}.`
      );
    }
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const ready = Promise.withResolvers<() => void>();
    const abort = (): void => {
      const index = this.waiting.indexOf(start);
      if (index >= 0) {
        this.waiting.splice(index, 1);
      }
      ready.reject(signal?.reason ?? new Error('Delegated work aborted.'));
    };
    const start = (): void => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        ready.reject(signal.reason);
        this.advance();
        return;
      }
      this.active += 1;
      let released = false;
      ready.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.active -= 1;
        this.advance();
      });
    };
    this.waiting.push(start);
    signal?.addEventListener('abort', abort, { once: true });
    this.advance();
    return await ready.promise;
  }

  private advance(): void {
    while (this.active < this.maxConcurrentWork && this.waiting.length > 0) {
      this.waiting.shift()?.();
    }
  }
}

/** Holds one permit from the model call until its stream ends, errors or is cancelled. */
export function hostPermitModel(
  model: Exclude<LanguageModel, string>,
  queue: HostChildWorkQueue,
  signal: AbortSignal
): Exclude<LanguageModel, string> {
  return wrapLanguageModel({
    middleware: {
      specificationVersion: 'v4',
      wrapStream: async ({ doStream }) => {
        const release = await queue.acquire(signal);
        signal.addEventListener('abort', release, { once: true });
        const done = (): void => {
          signal.removeEventListener('abort', release);
          release();
        };
        try {
          const result = await doStream();
          const reader = result.stream.getReader();
          return {
            ...result,
            stream: new ReadableStream({
              cancel: (reason) => {
                done();
                return reader.cancel(reason);
              },
              pull: async (controller) => {
                try {
                  const next = await reader.read();
                  if (next.done) {
                    done();
                    controller.close();
                    return;
                  }
                  controller.enqueue(next.value);
                } catch (cause) {
                  done();
                  controller.error(cause);
                }
              },
            }),
          };
        } catch (cause) {
          done();
          throw cause;
        }
      },
    },
    model,
  });
}
