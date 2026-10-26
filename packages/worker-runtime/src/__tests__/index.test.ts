import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalRuntimeFailureLatch,
  createWorkerRuntimeClient,
  createWorkerTransport,
  deserializeRuntimeError,
} from '../index.ts';

describe('@brainstrike/worker-runtime', () => {
  it('latches terminal failures until cleared', () => {
    const latch = createTerminalRuntimeFailureLatch();
    const failure = latch.markFailed(new Error('fatal runtime failure'));

    expect(latch.isFailed()).toBe(true);
    expect(failure.message).toBe('fatal runtime failure');
    expect(() => latch.throwIfFailed()).toThrow('fatal runtime failure');

    latch.clear();
    expect(latch.isFailed()).toBe(false);
  });

  it('keeps the first terminal failure until cleared', () => {
    const latch = createTerminalRuntimeFailureLatch();
    const first = latch.markFailed('first failure');
    const second = latch.markFailed(new Error('second failure'));

    expect(second).toBe(first);
    expect(latch.getFailure()?.message).toBe('first failure');
  });

  it('restores runtime errors', () => {
    const serialized = {
      cause: 'root-cause',
      code: 'E_RUNTIME',
      message: 'boom',
      name: 'Error',
    };
    const restored = deserializeRuntimeError(serialized) as Error & {
      code?: string;
      cause?: string;
    };

    expect(restored.message).toBe('boom');
    expect(restored.code).toBe('E_RUNTIME');
    expect(restored.cause).toBe('root-cause');
  });

  it('normalizes non-Error runtime errors', () => {
    expect(deserializeRuntimeError('boom').message).toBe('boom');
    expect(deserializeRuntimeError({ message: 'y', name: 'X' }).message).toBe('y');
  });

  it('tracks worker readiness and latches worker error events', () => {
    const errorHandlers = new Set<(event: ErrorEvent) => void>();
    const worker = {
      addEventListener: vi.fn((type: string, handler: (event: ErrorEvent) => void) => {
        if (type === 'error') {
          errorHandlers.add(handler);
        }
      }),
      postMessage: vi.fn(),
      removeEventListener: vi.fn((type: string, handler: (event: ErrorEvent) => void) => {
        if (type === 'error') {
          errorHandlers.delete(handler);
        }
      }),
    } as unknown as Worker;

    const failures: string[] = [];
    const client = createWorkerRuntimeClient(worker, {
      onFailure: (error) => {
        failures.push(error.message);
      },
    });

    client.markReady();
    expect(client.isReady()).toBe(true);

    for (const handler of errorHandlers) {
      handler({ message: 'boom' } as ErrorEvent);
    }

    expect(client.isReady()).toBe(false);
    expect(client.isFailed()).toBe(true);
    expect(failures).toEqual(['Worker runtime error: boom']);

    client.dispose();
    expect(worker.removeEventListener).toHaveBeenCalled();
  });

  it('handles worker transport subscriptions and transfer lists', () => {
    const messageHandlers = new Set<(event: MessageEvent<unknown>) => void>();
    const worker = {
      addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => void) => {
        if (type === 'message') {
          messageHandlers.add(handler);
        }
      }),
      postMessage: vi.fn(),
      removeEventListener: vi.fn(
        (type: string, handler: (event: MessageEvent<unknown>) => void) => {
          if (type === 'message') {
            messageHandlers.delete(handler);
          }
        }
      ),
    } as unknown as Worker;

    const transport = createWorkerTransport(worker);
    const listener = vi.fn();
    const unsubscribe = transport.onMessage(listener);

    for (const handler of messageHandlers) {
      handler({ data: { ok: true } } as MessageEvent<unknown>);
    }

    const transfer = new ArrayBuffer(8);
    transport.postMessage({ hello: 'world' }, [transfer]);
    unsubscribe();
    transport.postMessage({ again: true });

    expect(listener).toHaveBeenCalledWith({ ok: true });
    expect(worker.postMessage).toHaveBeenNthCalledWith(1, { hello: 'world' }, [transfer]);
    expect(worker.postMessage).toHaveBeenNthCalledWith(2, { again: true });
    expect(worker.removeEventListener).toHaveBeenCalled();
  });

  it('supports custom worker runtime failure handling', () => {
    const errorHandlers = new Set<(event: ErrorEvent) => void>();
    const worker = {
      addEventListener: vi.fn((type: string, handler: (event: ErrorEvent) => void) => {
        if (type === 'error') {
          errorHandlers.add(handler);
        }
      }),
      postMessage: vi.fn(),
      removeEventListener: vi.fn((type: string, handler: (event: ErrorEvent) => void) => {
        if (type === 'error') {
          errorHandlers.delete(handler);
        }
      }),
    } as unknown as Worker;

    const failures: string[] = [];
    const client = createWorkerRuntimeClient(worker, {
      createErrorFromEvent: () => new Error('custom failure'),
      onFailure: (error) => {
        failures.push(error.message);
      },
    });

    client.markReady();
    for (const handler of errorHandlers) {
      handler({
        message: '',
        preventDefault: vi.fn(),
      } as unknown as ErrorEvent);
    }

    expect(client.isReady()).toBe(false);
    expect(client.getFailure()?.message).toBe('custom failure');
    expect(() => client.throwIfFailed()).toThrow('custom failure');

    client.clearFailure();
    client.resetReady();
    expect(client.isFailed()).toBe(false);
  });
});
