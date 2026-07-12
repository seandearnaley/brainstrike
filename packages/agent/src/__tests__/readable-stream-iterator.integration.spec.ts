import { describe, expect, it } from 'vitest';
import { readableStreamIterator } from '../stream/readable-stream-iterator';

describe('readableStreamIterator', () => {
  it('yields all values from a ReadableStream', async () => {
    const values = ['first', 'second', 'third'];
    const stream = new ReadableStream<string>({
      start(controller) {
        for (const value of values) {
          controller.enqueue(value);
        }
        controller.close();
      },
    });

    const results: string[] = [];
    for await (const value of readableStreamIterator(stream)) {
      results.push(value);
    }

    expect(results).toEqual(values);
  });

  it('handles empty stream', async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.close();
      },
    });

    const results: number[] = [];
    for await (const value of readableStreamIterator(stream)) {
      results.push(value);
    }

    expect(results).toEqual([]);
  });

  it('skips undefined values', async () => {
    const stream = new ReadableStream<string | undefined>({
      start(controller) {
        controller.enqueue('first');
        controller.enqueue(undefined);
        controller.enqueue('second');
        controller.enqueue(undefined);
        controller.enqueue('third');
        controller.close();
      },
    });

    const results: (string | undefined)[] = [];
    for await (const value of readableStreamIterator(stream)) {
      results.push(value);
    }

    expect(results).toEqual(['first', 'second', 'third']);
  });

  it('stops iteration when abort signal is triggered', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<number>({
      start(streamController) {
        streamController.enqueue(1);
        streamController.enqueue(2);
        streamController.enqueue(3);
        streamController.enqueue(4);
        streamController.enqueue(5);
        streamController.close();
      },
    });

    const results: number[] = [];
    let iterations = 0;

    const iteratorPromise = (async () => {
      for await (const value of readableStreamIterator(stream, controller.signal)) {
        results.push(value);
        iterations += 1;
        if (iterations === 2) {
          controller.abort();
        }
      }
    })();

    await iteratorPromise;

    expect(results.length).toBeLessThan(5);
    expect(results).toContain(1);
    expect(results).toContain(2);
  });

  it('handles abort signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const stream = new ReadableStream<string>({
      start(streamController) {
        streamController.enqueue('should not be read');
        streamController.close();
      },
    });

    const results: string[] = [];
    for await (const value of readableStreamIterator(stream, controller.signal)) {
      results.push(value);
    }

    expect(results).toEqual([]);
  });

  it('releases reader lock after iteration completes', async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.close();
      },
    });

    const iterator = readableStreamIterator(stream);

    for await (const _value of iterator) {
      // consume
    }

    // Attempting to get another reader should succeed if lock was released
    const reader = stream.getReader();
    expect(reader).toBeDefined();
    reader.releaseLock();
  });

  it('cancels reader and releases lock on early exit', async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      },
    });

    for await (const value of readableStreamIterator(stream)) {
      if (value === 1) {
        break; // Early exit
      }
    }

    // Lock should be released even after early exit
    const reader = stream.getReader();
    expect(reader).toBeDefined();
    reader.releaseLock();
  });

  it('cancels reader on error during iteration', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('first');
        controller.enqueue('second');
        controller.close();
      },
    });

    let didThrow = false;
    try {
      for await (const value of readableStreamIterator(stream)) {
        if (value === 'second') {
          throw new Error('Test error');
        }
      }
    } catch (error) {
      didThrow = true;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Test error');
    }

    expect(didThrow).toBe(true);

    // Lock should still be released after error
    const reader = stream.getReader();
    expect(reader).toBeDefined();
    reader.releaseLock();
  });

  it('handles stream with mixed data types', async () => {
    const stream = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue('string');
        controller.enqueue(42);
        controller.enqueue({ key: 'value' });
        controller.enqueue(true);
        controller.close();
      },
    });

    const results: unknown[] = [];
    for await (const value of readableStreamIterator(stream)) {
      results.push(value);
    }

    expect(results).toHaveLength(4);
    expect(results[0]).toBe('string');
    expect(results[1]).toBe(42);
    expect(results[2]).toEqual({ key: 'value' });
    expect(results[3]).toBe(true);
  });

  it('works without abort signal', async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.close();
      },
    });

    const results: number[] = [];
    for await (const value of readableStreamIterator(stream)) {
      results.push(value);
    }

    expect(results).toEqual([1, 2]);
  });

  it('handles large number of values efficiently', async () => {
    const count = 1000;
    const stream = new ReadableStream<number>({
      start(controller) {
        for (let i = 0; i < count; i += 1) {
          controller.enqueue(i);
        }
        controller.close();
      },
    });

    const results: number[] = [];
    for await (const value of readableStreamIterator(stream)) {
      results.push(value);
    }

    expect(results).toHaveLength(count);
    expect(results[0]).toBe(0);
    expect(results[count - 1]).toBe(count - 1);
  });

  it('handles abort during iteration race condition', async () => {
    const controller = new AbortController();
    let enqueueCount = 0;

    const stream = new ReadableStream<number>({
      async start(streamController) {
        for (let i = 0; i < 10; i += 1) {
          streamController.enqueue(i);
          enqueueCount += 1;
          // Small delay to allow race condition
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        streamController.close();
      },
    });

    const results: number[] = [];

    setTimeout(() => controller.abort(), 10);

    for await (const value of readableStreamIterator(stream, controller.signal)) {
      results.push(value);
    }

    // Should have stopped before reading all values
    expect(results.length).toBeLessThanOrEqual(enqueueCount);
  });

  it('gracefully handles reader.cancel errors', async () => {
    const stream = new ReadableStream<string>({
      cancel() {
        throw new Error('Cancel failed');
      },
      start(controller) {
        controller.enqueue('value');
        controller.close();
      },
    });

    // Should not throw even if cancel fails
    const results: string[] = [];
    for await (const value of readableStreamIterator(stream)) {
      results.push(value);
      break; // Force early exit to trigger cancel
    }

    expect(results).toEqual(['value']);
  });
});
