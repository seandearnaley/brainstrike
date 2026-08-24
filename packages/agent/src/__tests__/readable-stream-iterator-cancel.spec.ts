import { describe, expect, it } from 'vitest';
import { readableStreamIterator } from '../stream/readable-stream-iterator';

/**
 * Cleanup must not leak an unhandled rejection when the stream ERRORED.
 *
 * `reader.cancel()` returns a PROMISE, and on an errored stream that promise
 * rejects with the stream's stored error. The cleanup used a `try`/`catch`,
 * which only catches synchronous throws — so every errored stream left a
 * dangling rejection behind.
 *
 * It surfaced when a harness gained a mid-stream failure seam, but it is a
 * production path: any provider transport error takes it. An unhandled
 * rejection is noise at best and fatal at worst depending on host config, and
 * it buries the real error underneath it.
 */
async function unhandledRejectionsDuring(run: () => Promise<void>): Promise<unknown[]> {
  const captured: unknown[] = [];
  const onUnhandled = (reason: unknown) => captured.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    // Let a dangling rejection reach the handler: it is reported a macrotask
    // after the microtask queue drains, so awaiting alone would miss it.
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return captured;
}

describe('readableStreamIterator cleanup on an errored stream', () => {
  it('surfaces the error to the CONSUMER without leaking a rejection', async () => {
    const boom = new Error('provider transport exploded');
    const captured = await unhandledRejectionsDuring(async () => {
      // PULL-driven, deliberately: `controller.error()` DISCARDS anything still
      // queued, so enqueue-then-error in `start` would never deliver a part and
      // this would silently become a failed-to-start case instead of the
      // mid-stream one it claims to cover.
      let pulls = 0;
      const stream = new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue('first');
            return;
          }
          controller.error(boom);
        },
      });

      const seen: unknown[] = [];
      await expect(async () => {
        for await (const part of readableStreamIterator(stream)) {
          seen.push(part);
        }
      }).rejects.toThrow('provider transport exploded');
      // Non-vacuity: the consumer really did receive the pre-error part, so
      // this is the mid-stream case and not a stream that failed to start.
      expect(seen).toEqual(['first']);
    });

    expect(captured).toEqual([]);
  });

  it('still leaks nothing for a stream that ends normally', () =>
    unhandledRejectionsDuring(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue('only');
          controller.close();
        },
      });
      const seen: unknown[] = [];
      for await (const part of readableStreamIterator(stream)) {
        seen.push(part);
      }
      expect(seen).toEqual(['only']);
    }).then((captured) => {
      expect(captured).toEqual([]);
    }));
});
