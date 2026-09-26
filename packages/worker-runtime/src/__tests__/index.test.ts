import type { LogRecord } from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  assertBackgroundRuntimeStatus,
  bindRuntimeLogRecord,
  createBackgroundRuntimeDescriptor,
  createBackgroundRuntimeLifecycleChannels,
  createBackgroundRuntimeScopedChannel,
  createBackgroundRuntimeScopedChannels,
  createBackgroundRuntimeStatus,
  createBackgroundRuntimeStatusAdapter,
  createRequestId,
  createRequestTracker,
  createRuntimeId,
  createRuntimeLogBindings,
  createRuntimeStatusStore,
  createStoppedBackgroundRuntimeStatus,
  createSubscriptionTransport,
  createTerminalRuntimeFailureLatch,
  createWorkerRuntimeClient,
  createWorkerTransport,
  deserializeRuntimeError,
  serializeRuntimeError,
} from '../index.js';
import {
  assertRuntimeObjectPayloadEnvelope,
  assertRuntimeRequestPayloadBase,
} from '../validation.js';

describe('@brainstrike/worker-runtime', () => {
  it('creates runtime ids with the runtime kind prefix', () => {
    const runtimeId = createRuntimeId('chunking-host');
    expect(runtimeId.startsWith('chunking-host:')).toBe(true);
  });

  it('creates request ids with the provided prefix', () => {
    const requestId = createRequestId('embed');
    expect(requestId.startsWith('embed:')).toBe(true);
  });

  it('fails fast when runtime ids cannot be created', () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', undefined);

    expect(() => createRuntimeId('chunking-host')).toThrow('crypto.randomUUID');
    expect(() => createRequestId('embed')).toThrow('crypto.randomUUID');

    vi.stubGlobal('crypto', originalCrypto);
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

  it('does not rebroadcast identical runtime status snapshots', () => {
    const initial = createBackgroundRuntimeStatus('embedding-host', 'runtime-1', 'running', {
      active: true,
    });
    const store = createRuntimeStatusStore(initial);
    const listener = vi.fn();

    const cleanup = store.subscribe(listener);

    const repeated = createBackgroundRuntimeStatus('embedding-host', 'runtime-1', 'running', {
      active: true,
    });
    expect(store.setStatus(repeated)).toEqual(repeated);
    cleanup();

    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects runtime statuses with non-canonical fields', () => {
    const initial = {
      ...createBackgroundRuntimeStatus('embedding-host', 'runtime-1', 'running', {
        active: true,
      }),
      phase: 'warming',
    };

    expect(() =>
      createRuntimeStatusStore(
        initial as BackgroundRuntimeStatus<'embedding-host'> & { readonly phase: string }
      )
    ).toThrow('Runtime status must not include non-canonical status field "phase".');
  });

  it('preserves explicitly allowed runtime status extension fields', () => {
    const initial = createBackgroundRuntimeStatus('embedding-host', 'runtime-1', 'running', {
      active: true,
    }) as BackgroundRuntimeStatus<'embedding-host'> & {
      readonly embeddingRuntime?: { readonly device: 'webgpu' };
    };
    const store = createRuntimeStatusStore(initial, {
      allowedExtensionKeys: ['embeddingRuntime'],
    });
    const listener = vi.fn();
    const cleanup = store.subscribe(listener);

    const status = {
      ...createBackgroundRuntimeStatus('embedding-host', 'runtime-1', 'running', {
        active: true,
      }),
      embeddingRuntime: { device: 'webgpu' as const },
    };

    expect(store.setStatus(status)).toEqual(status);
    expect(store.getStatus()).toEqual(status);
    expect(listener).toHaveBeenCalledWith(status);
    cleanup();
  });

  it('creates stopped statuses with canonical runtime ids', () => {
    expect(createStoppedBackgroundRuntimeStatus('chunking-host')).toEqual({
      active: false,
      lastError: null,
      runtimeId: 'chunking-host:stopped',
      runtimeKind: 'chunking-host',
      state: 'stopped',
    });
  });

  it('strictly validates runtime status payloads', () => {
    expect(
      assertBackgroundRuntimeStatus(
        {
          active: true,
          lastError: null,
          runtimeId: 'embedding-host:123',
          runtimeKind: 'embedding-host',
          state: 'running',
        },
        'embedding-host'
      )
    ).toEqual({
      active: true,
      lastError: null,
      runtimeId: 'embedding-host:123',
      runtimeKind: 'embedding-host',
      state: 'running',
    });

    expect(() =>
      assertBackgroundRuntimeStatus(
        {
          active: true,
          lastError: null,
          runtimeId: 'embedding-host:123',
          runtimeKind: 'embedding-worker',
          state: 'running',
        },
        'embedding-host'
      )
    ).toThrow('embedding-host status report must include runtimeKind="embedding-host".');
  });

  it('builds strict runtime status adapters for host runtimes', () => {
    const adapter = createBackgroundRuntimeStatusAdapter('chunking-host');

    expect(
      adapter.createStatus({
        active: true,
        lastError: null,
        runtimeId: 'chunking-host:runtime-1',
        state: 'running',
      })
    ).toEqual({
      active: true,
      lastError: null,
      runtimeId: 'chunking-host:runtime-1',
      runtimeKind: 'chunking-host',
      state: 'running',
    });

    expect(adapter.createStoppedStatus()).toEqual({
      active: false,
      lastError: null,
      runtimeId: 'chunking-host:stopped',
      runtimeKind: 'chunking-host',
      state: 'stopped',
    });

    expect(
      adapter.assertStatus({
        active: false,
        lastError: 'boom',
        runtimeId: 'chunking-host:runtime-2',
        runtimeKind: 'chunking-host',
        state: 'error',
      })
    ).toEqual({
      active: false,
      lastError: 'boom',
      runtimeId: 'chunking-host:runtime-2',
      runtimeKind: 'chunking-host',
      state: 'error',
    });
  });

  it('builds canonical scoped runtime channels', () => {
    expect(createBackgroundRuntimeScopedChannel('embedding-host', 'command')).toBe(
      'embedding-host:command'
    );
    expect(
      createBackgroundRuntimeScopedChannels('chunking-host', {
        progress: 'progress',
        reportResponse: 'report-response',
      })
    ).toEqual({
      progress: 'chunking-host:progress',
      reportResponse: 'chunking-host:report-response',
    });
    expect(createBackgroundRuntimeLifecycleChannels('chunking-host')).toEqual({
      ensureStarted: 'chunking-host:ensure-started',
      getStatus: 'chunking-host:get-status',
      reportStatus: 'chunking-host:report-status',
      reset: 'chunking-host:reset',
      statusEvent: 'chunking-host:status',
      stop: 'chunking-host:stop',
    });
  });

  it('builds canonical runtime descriptors', () => {
    const descriptor = createBackgroundRuntimeDescriptor('embedding-host');

    expect(descriptor.runtimeKind).toBe('embedding-host');
    expect(descriptor.stoppedRuntimeId).toBe('embedding-host:stopped');
    expect(descriptor.lifecycleChannels.statusEvent).toBe('embedding-host:status');
    expect(descriptor.createScopedChannel('backfill-progress')).toBe(
      'embedding-host:backfill-progress'
    );
    expect(
      descriptor.createScopedChannels({
        command: 'command',
        enqueueBackfill: 'enqueue-backfill',
      })
    ).toEqual({
      command: 'embedding-host:command',
      enqueueBackfill: 'embedding-host:enqueue-backfill',
    });
    expect(descriptor.createStoppedStatus()).toEqual({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:stopped',
      runtimeKind: 'embedding-host',
      state: 'stopped',
    });
  });

  it('strictly asserts runtime envelopes with object payloads', () => {
    expect(
      assertRuntimeObjectPayloadEnvelope(
        {
          channel: 'chunking-host:progress',
          payload: {
            currentIndex: 1,
          },
          requestId: 'request-1',
          runtimeId: 'chunking-host:runtime-1',
          type: 'progress',
        },
        'Chunking host response report'
      )
    ).toEqual({
      candidate: {
        channel: 'chunking-host:progress',
        payload: {
          currentIndex: 1,
        },
        requestId: 'request-1',
        runtimeId: 'chunking-host:runtime-1',
        type: 'progress',
      },
      envelopeBase: {
        channel: 'chunking-host:progress',
        requestId: 'request-1',
        runtimeId: 'chunking-host:runtime-1',
        type: 'progress',
      },
      payload: {
        currentIndex: 1,
      },
    });

    expect(() =>
      assertRuntimeObjectPayloadEnvelope(
        {
          channel: 'chunking-host:progress',
          payload: {},
          requestId: 'request-1',
          runtimeId: 'chunking-host:runtime-1',
          type: 'wat',
        },
        'Chunking host response report'
      )
    ).toThrow('Chunking host response report must include a valid runtime envelope type.');
  });

  it('rejects malformed runtime envelopes', () => {
    expect(() => assertRuntimeObjectPayloadEnvelope(null, 'Runtime envelope')).toThrow(
      'Runtime envelope must be an object.'
    );
    expect(() =>
      assertRuntimeObjectPayloadEnvelope(
        {
          channel: 'chunking-host:progress',
          payload: {},
          requestId: '',
          runtimeId: 'chunking-host:runtime-1',
          type: 'progress',
        },
        'Runtime envelope'
      )
    ).toThrow('Runtime envelope must include a non-empty requestId.');
    expect(() =>
      assertRuntimeObjectPayloadEnvelope(
        {
          channel: '',
          payload: {},
          requestId: 'request-1',
          runtimeId: 'chunking-host:runtime-1',
          type: 'progress',
        },
        'Runtime envelope'
      )
    ).toThrow('Runtime envelope must include a non-empty channel.');
    expect(() =>
      assertRuntimeObjectPayloadEnvelope(
        {
          channel: 'chunking-host:progress',
          payload: {},
          requestId: 'request-1',
          runtimeId: '',
          type: 'progress',
        },
        'Runtime envelope'
      )
    ).toThrow('Runtime envelope must include a non-empty runtimeId.');
    expect(() =>
      assertRuntimeObjectPayloadEnvelope(
        {
          channel: 'chunking-host:progress',
          payload: [],
          requestId: 'request-1',
          runtimeId: 'chunking-host:runtime-1',
          type: 'progress',
        },
        'Runtime envelope'
      )
    ).toThrow('Runtime envelope must include a payload object.');
  });

  it('strictly asserts request payload bases', () => {
    expect(
      assertRuntimeRequestPayloadBase(
        {
          content: 'hello',
          kind: 'chunk-file',
          requestId: 'request-1',
        },
        'Chunking host chunk-file request',
        'chunk-file'
      )
    ).toEqual({
      candidate: {
        content: 'hello',
        kind: 'chunk-file',
        requestId: 'request-1',
      },
      requestBase: {
        kind: 'chunk-file',
        requestId: 'request-1',
      },
    });

    expect(() =>
      assertRuntimeRequestPayloadBase(
        {
          kind: 'chunk-batch',
          requestId: 'request-1',
        },
        'Chunking host chunk-file request',
        'chunk-file'
      )
    ).toThrow('Chunking host chunk-file request must declare kind="chunk-file".');
  });

  it('rejects malformed request payload bases', () => {
    expect(() => assertRuntimeRequestPayloadBase(null, 'Chunk request', 'chunk-file')).toThrow(
      'Chunk request must be an object.'
    );
    expect(() =>
      assertRuntimeRequestPayloadBase(
        {
          kind: 'chunk-file',
          requestId: '   ',
        },
        'Chunk request',
        'chunk-file'
      )
    ).toThrow('Chunk request must include a non-empty requestId.');
  });

  it('tracks pending requests and fails duplicate ids', () => {
    const tracker = createRequestTracker<number>();
    tracker.register('request-1', 42);

    expect(tracker.get('request-1')).toBe(42);
    expect(() => tracker.register('request-1', 7)).toThrow(/Duplicate runtime request ID/);
    expect(tracker.take('request-1')).toBe(42);
    expect(tracker.get('request-1')).toBeUndefined();
  });

  it('supports clearing, deleting, draining, and enumerating tracked requests', () => {
    const tracker = createRequestTracker<number>();
    tracker.register('request-1', 1);
    tracker.register('request-2', 2);

    expect(tracker.has('request-1')).toBe(true);
    expect(tracker.size()).toBe(2);
    expect(tracker.entries()).toEqual([
      ['request-1', 1],
      ['request-2', 2],
    ]);
    expect(tracker.delete('request-1')).toBe(true);
    expect(tracker.delete('missing')).toBe(false);
    expect(tracker.drain()).toEqual([['request-2', 2]]);
    expect(tracker.size()).toBe(0);

    tracker.register('request-3', 3);
    tracker.clear();
    expect(tracker.size()).toBe(0);
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

  it('keeps the first terminal failure until cleared', () => {
    const latch = createTerminalRuntimeFailureLatch();
    const first = latch.markFailed('first failure');
    const second = latch.markFailed(new Error('second failure'));

    expect(second).toBe(first);
    expect(latch.getFailure()?.message).toBe('first failure');
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
      cause: 'root-cause',
      code: 'E_RUNTIME',
      message: 'boom',
      name: 'Error',
    });
    expect(restored.message).toBe('boom');
    expect(restored.code).toBe('E_RUNTIME');
    expect(restored.cause).toBe('root-cause');
  });

  it('normalizes non-Error runtime errors', () => {
    expect(serializeRuntimeError('boom')).toMatchObject({
      message: 'boom',
      name: 'Error',
    });
    expect(deserializeRuntimeError('boom').message).toBe('boom');
    expect(deserializeRuntimeError({ message: 'y', name: 'X' }).message).toBe('y');
  });

  it('rejects invalid background runtime status payloads', () => {
    expect(() => assertBackgroundRuntimeStatus(null, 'embedding-host')).toThrow(
      'embedding-host status report must be an object.'
    );
    expect(() =>
      assertBackgroundRuntimeStatus(
        {
          active: true,
          lastError: null,
          runtimeId: 'embedding-host:1',
          runtimeKind: 'embedding-host',
          state: 'wat',
        },
        'embedding-host'
      )
    ).toThrow('embedding-host status report has invalid state.');
    expect(() =>
      assertBackgroundRuntimeStatus(
        {
          active: 'yes',
          lastError: null,
          runtimeId: 'embedding-host:1',
          runtimeKind: 'embedding-host',
          state: 'running',
        },
        'embedding-host'
      )
    ).toThrow('embedding-host status report must include active boolean.');
    expect(() =>
      assertBackgroundRuntimeStatus(
        {
          active: true,
          lastError: 42,
          runtimeId: 'embedding-host:1',
          runtimeKind: 'embedding-host',
          state: 'running',
        },
        'embedding-host'
      )
    ).toThrow('embedding-host status report must include string or null lastError.');
    expect(() =>
      assertBackgroundRuntimeStatus(
        {
          active: true,
          lastError: null,
          runtimeId: '',
          runtimeKind: 'embedding-host',
          state: 'running',
        },
        'embedding-host'
      )
    ).toThrow('embedding-host status report must include a non-empty runtimeId.');
  });

  it('creates runtime log bindings without optional fields', () => {
    expect(
      createRuntimeLogBindings({
        runtimeId: 'embedding-host:1',
        runtimeKind: 'embedding-host',
      })
    ).toEqual({
      runtimeId: 'embedding-host:1',
      runtimeKind: 'embedding-host',
    });
  });

  it('binds runtime metadata into log records', () => {
    const record: LogRecord = {
      args: ['hello'],
      bindings: { runtime: 'electron-renderer' },
      level: 'info',
      message: 'hello',
      scope: 'TestScope',
      timestamp: Date.now(),
    };

    const bound = bindRuntimeLogRecord(record, {
      channel: 'control',
      requestId: 'request-1',
      runtimeId: 'runtime-1',
      runtimeKind: 'embedding-host',
      windowRole: 'embedding-host',
    });

    expect(bound.bindings).toMatchObject({
      channel: 'control',
      requestId: 'request-1',
      runtime: 'electron-renderer',
      runtimeId: 'runtime-1',
      runtimeKind: 'embedding-host',
      windowRole: 'embedding-host',
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

  it('supports custom worker runtime failure handling and subscription transports', () => {
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

    const subscriptionListener = vi.fn();
    const subscribe = vi.fn((listener: (message: unknown) => void) => {
      listener({ subscribed: true });
      return () => {
        subscriptionListener('unsubscribed');
      };
    });
    const postMessage = vi.fn();
    const transport = createSubscriptionTransport({
      postMessage,
      subscribe,
    });

    const cleanup = transport.onMessage(subscriptionListener);
    transport.postMessage({ ping: true });
    cleanup();

    expect(subscriptionListener).toHaveBeenCalledWith({ subscribed: true });
    expect(subscriptionListener).toHaveBeenCalledWith('unsubscribed');
    expect(postMessage).toHaveBeenCalledWith({ ping: true });
  });
});
