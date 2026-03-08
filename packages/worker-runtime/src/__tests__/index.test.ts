import type { LogRecord } from '@brainstrike/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  assertBackgroundRuntimeStatus,
  bindRuntimeLogRecord,
  createBackgroundRuntimeStatus,
  createBackgroundRuntimeStatusAdapter,
  createRequestTracker,
  createRuntimeId,
  createRuntimeStatusStore,
  createStoppedBackgroundRuntimeStatus,
  createTerminalRuntimeFailureLatch,
  createWorkerRuntimeClient,
  deserializeRuntimeError,
  serializeRuntimeError,
} from '../index';

describe('@brainstrike/worker-runtime', () => {
  it('creates runtime ids with the runtime kind prefix', () => {
    const runtimeId = createRuntimeId('chunking-host');
    expect(runtimeId.startsWith('chunking-host:')).toBe(true);
  });

  it('stores and broadcasts status transitions', () => {
    const initial = createBackgroundRuntimeStatus('embedding-host', 'runtime-1', 'stopped');
    const store = createRuntimeStatusStore(initial);
    const statuses: string[] = [];

    const cleanup = store.subscribe((status) => {
      statuses.push(status.state);
    });

    store.setStatus(createBackgroundRuntimeStatus('embedding-host', 'runtime-1', 'starting'));
    store.setStatus(
      createBackgroundRuntimeStatus('embedding-host', 'runtime-1', 'running', { active: true })
    );
    cleanup();

    expect(store.getStatus().state).toBe('running');
    expect(statuses).toEqual(['starting', 'running']);
  });

  it('creates stopped statuses with canonical runtime ids', () => {
    expect(createStoppedBackgroundRuntimeStatus('chunking-host')).toEqual({
      runtimeKind: 'chunking-host',
      runtimeId: 'chunking-host:stopped',
      state: 'stopped',
      active: false,
      lastError: null,
    });
  });

  it('strictly validates runtime status payloads', () => {
    expect(
      assertBackgroundRuntimeStatus(
        {
          runtimeKind: 'embedding-host',
          runtimeId: 'embedding-host:123',
          state: 'running',
          active: true,
          lastError: null,
        },
        'embedding-host'
      )
    ).toEqual({
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host:123',
      state: 'running',
      active: true,
      lastError: null,
    });

    expect(() =>
      assertBackgroundRuntimeStatus(
        {
          runtimeKind: 'embedding-worker',
          runtimeId: 'embedding-host:123',
          state: 'running',
          active: true,
          lastError: null,
        },
        'embedding-host'
      )
    ).toThrow('embedding-host status report must include runtimeKind="embedding-host".');
  });

  it('builds strict runtime status adapters for host runtimes', () => {
    const adapter = createBackgroundRuntimeStatusAdapter('chunking-host');

    expect(
      adapter.createStatus({
        runtimeId: 'chunking-host:runtime-1',
        state: 'running',
        active: true,
        lastError: null,
      })
    ).toEqual({
      runtimeKind: 'chunking-host',
      runtimeId: 'chunking-host:runtime-1',
      state: 'running',
      active: true,
      lastError: null,
    });

    expect(adapter.createStoppedStatus()).toEqual({
      runtimeKind: 'chunking-host',
      runtimeId: 'chunking-host:stopped',
      state: 'stopped',
      active: false,
      lastError: null,
    });

    expect(
      adapter.assertStatus({
        runtimeKind: 'chunking-host',
        runtimeId: 'chunking-host:runtime-2',
        state: 'error',
        active: false,
        lastError: 'boom',
      })
    ).toEqual({
      runtimeKind: 'chunking-host',
      runtimeId: 'chunking-host:runtime-2',
      state: 'error',
      active: false,
      lastError: 'boom',
    });
  });

  it('tracks pending requests and fails duplicate ids', () => {
    const tracker = createRequestTracker<number>();
    tracker.register('request-1', 42);

    expect(tracker.get('request-1')).toBe(42);
    expect(() => tracker.register('request-1', 7)).toThrow(/Duplicate runtime request ID/);
    expect(tracker.take('request-1')).toBe(42);
    expect(tracker.get('request-1')).toBeUndefined();
  });

  it('latches terminal failures until cleared', () => {
    const latch = createTerminalRuntimeFailureLatch();
    const failure = latch.markFailed(new Error('fatal runtime failure'));

    expect(latch.isFailed()).toBe(true);
    expect(failure.message).toBe('fatal runtime failure');
    expect(() => latch.throwIfFailed()).toThrow('fatal runtime failure');

    latch.clear();
    expect(latch.isFailed()).toBe(false);
  });

  it('serializes and restores runtime errors', () => {
    const original = new Error('boom') as Error & { code?: string; cause?: string };
    original.code = 'E_RUNTIME';
    original.cause = 'root-cause';

    const serialized = serializeRuntimeError(original);
    const restored = deserializeRuntimeError(serialized) as Error & {
      code?: string;
      cause?: string;
    };

    expect(serialized).toMatchObject({
      name: 'Error',
      message: 'boom',
      code: 'E_RUNTIME',
      cause: 'root-cause',
    });
    expect(restored.message).toBe('boom');
    expect(restored.code).toBe('E_RUNTIME');
    expect(restored.cause).toBe('root-cause');
  });

  it('binds runtime metadata into log records', () => {
    const record: LogRecord = {
      level: 'info',
      timestamp: Date.now(),
      args: ['hello'],
      bindings: { runtime: 'electron-renderer' },
      message: 'hello',
      scope: 'TestScope',
    };

    const bound = bindRuntimeLogRecord(record, {
      runtimeKind: 'embedding-host',
      runtimeId: 'runtime-1',
      windowRole: 'embedding-host',
      channel: 'control',
      requestId: 'request-1',
    });

    expect(bound.bindings).toMatchObject({
      runtime: 'electron-renderer',
      runtimeKind: 'embedding-host',
      runtimeId: 'runtime-1',
      windowRole: 'embedding-host',
      channel: 'control',
      requestId: 'request-1',
    });
  });

  it('tracks worker readiness and latches worker error events', () => {
    const errorHandlers = new Set<(event: ErrorEvent) => void>();
    const worker = {
      addEventListener: vi.fn((type: string, handler: (event: ErrorEvent) => void) => {
        if (type === 'error') {
          errorHandlers.add(handler);
        }
      }),
      removeEventListener: vi.fn((type: string, handler: (event: ErrorEvent) => void) => {
        if (type === 'error') {
          errorHandlers.delete(handler);
        }
      }),
      postMessage: vi.fn(),
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
});
