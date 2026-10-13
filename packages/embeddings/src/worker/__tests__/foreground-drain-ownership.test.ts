import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleEmbeddingService } from '../../bge-m3-service.js';
import { registerEmbeddingQueueFactory, resetEmbeddingQueueFactory } from '../../runtime-config.js';
import {
  createForegroundEmbeddingGate,
  runCoordinatedQueryEmbedding,
} from '../foreground-embedding-gate.js';

class ControlledWorker {
  static readonly instances: ControlledWorker[] = [];
  private readonly listeners = new Map<string, Set<(event: { data: unknown }) => void>>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  constructor() {
    ControlledWorker.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(message: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: message });
    }
  }
}

async function createRunningBackgroundAndForeground() {
  const add = vi.fn<QueueAdapter['add']>(
    async (task): Promise<QueueResult> => ({
      id: task.id,
      metadata: {
        batchSize: 1,
        device: 'webgpu',
        dimensions: 2,
        dtype: 'fp16',
        elapsedMs: 1,
        fallbackApplied: false,
        model: task.model,
        pooling: 'mean',
      },
      type: 'result',
      vectors: [Float32Array.from([0.1, 0.2])],
    })
  );
  const queue: QueueAdapter = {
    add,
    addBulk: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    isPaused: false,
    isProcessing: false,
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  registerEmbeddingQueueFactory(() => queue);
  const model = {
    description: '',
    dimensions: 2,
    id: 'local:model-a',
    name: 'Fixture',
    tags: ['local'],
  };
  const background = new SimpleEmbeddingService({
    streamingWorkerUrl: 'https://fixture.invalid/embedding-worker.js',
  });
  const foreground = new SimpleEmbeddingService();
  await background.initializeWithModel(model, undefined, 'webgpu');
  await foreground.initializeWithModel(model, undefined, 'webgpu');
  let active = true;
  const stream = background
    .generateEmbeddingsStream(['controlled background fixture'], async () => {})
    .finally(() => {
      active = false;
    });
  await Promise.resolve();
  await Promise.resolve();
  const worker = ControlledWorker.instances[0]!;
  const request = worker.postMessage.mock.calls[0]![0].request;
  let finished = false;
  const finish = async (): Promise<void> => {
    if (!finished) {
      finished = true;
      worker.emit({
        batchIndex: 0,
        endIndex: 1,
        id: request.id,
        peakVectorsInFlight: 1,
        startIndex: 0,
        transferBytes: 8,
        type: 'batch',
        vectors: [Float32Array.from([0.3, 0.4])],
        vectorsInFlight: 1,
      });
      worker.emit({
        id: request.id,
        metadata: {
          batchSize: 1,
          device: 'webgpu',
          dimensions: 2,
          dtype: 'fp16',
          elapsedMs: 5001,
          fallbackApplied: false,
          model: request.model,
          pooling: 'mean',
        },
        type: 'complete',
      });
    }
    await stream;
  };
  return { add, background, finish, foreground, isActive: () => active, worker };
}

describe('public streamed background and foreground drain ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', ControlledWorker);
    ControlledWorker.instances.length = 0;
  });
  afterEach(() => {
    resetEmbeddingQueueFactory();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not enter foreground inference after a five-second drain expires while background inference remains active', async () => {
    const run = await createRunningBackgroundAndForeground();
    const gate = createForegroundEmbeddingGate();
    const onDrainTimeout = vi.fn();
    const pending = runCoordinatedQueryEmbedding({
      drainTimeoutMs: 5000,
      gate,
      generate: () => run.foreground.generateQueryEmbedding('foreground fixture'),
      isWorkerActive: run.isActive,
      onDrainTimeout,
    });
    const outcome = pending.then(
      (result) => result,
      (error: unknown) => error
    );
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(run.isActive()).toBe(true);
      expect(onDrainTimeout).toHaveBeenCalledOnce();
      expect(run.add.mock.calls.length).toBe(0);
      expect(await outcome).toMatchObject({
        message:
          'Background embedding inference did not drain before the foreground query deadline.',
      });
    } finally {
      await run.finish();
      await outcome;
      await run.background.dispose();
      await run.foreground.dispose();
      await vi.advanceTimersByTimeAsync(250);
    }
  });

  it('starts foreground inference after the existing streamed background finishes', async () => {
    const run = await createRunningBackgroundAndForeground();
    const gate = createForegroundEmbeddingGate();
    const pending = runCoordinatedQueryEmbedding({
      drainTimeoutMs: 5000,
      gate,
      generate: () => run.foreground.generateQueryEmbedding('foreground fixture'),
      isWorkerActive: run.isActive,
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(run.add.mock.calls.length).toBe(0);
    await run.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ embedding: [expect.closeTo(0.1), expect.closeTo(0.2)] });
    expect(run.add).toHaveBeenCalledOnce();
    await run.background.dispose();
    await run.foreground.dispose();
    await vi.advanceTimersByTimeAsync(250);
    expect(gate.isActive()).toBe(false);
  });

  it('aborts only the foreground drain wait and leaves the existing background stream alive', async () => {
    const run = await createRunningBackgroundAndForeground();
    const gate = createForegroundEmbeddingGate();
    const controller = new AbortController();
    const pending = runCoordinatedQueryEmbedding({
      drainTimeoutMs: 5000,
      gate,
      generate: () => run.foreground.generateQueryEmbedding('foreground fixture'),
      isWorkerActive: run.isActive,
      signal: controller.signal,
    });
    const outcome = pending.then(
      () => null,
      (error: unknown) => error
    );
    controller.abort();
    expect(await outcome).toBe(controller.signal.reason);
    expect(run.isActive()).toBe(true);
    expect(run.add.mock.calls.length).toBe(0);
    expect(run.worker.terminate).not.toHaveBeenCalled();
    await run.finish();
    await run.background.dispose();
    await run.foreground.dispose();
    await vi.advanceTimersByTimeAsync(250);
    expect(gate.isActive()).toBe(false);
  });
});
