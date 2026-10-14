import { MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { expect, it, vi } from 'vitest';
import { attachStandInTokenizer } from '../test/helpers/stand-in-tokenizer';

const BATCH_SIZE = 8;
const INPUT_COUNT = 4096;
const EXPECTED_BATCH_COUNT = INPUT_COUNT / BATCH_SIZE;
const BATCH_PAYLOAD_BYTES = BATCH_SIZE * MAX_EMBEDDING_DIMENSION * Float32Array.BYTES_PER_ELEMENT;
const MAX_ARRAY_BUFFER_DELTA_BYTES = BATCH_PAYLOAD_BYTES * 8;

const pipelineMock = vi.fn();

class MockTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];

  constructor(values: readonly number[], dims: readonly number[]) {
    this.data = Float32Array.from(values);
    this.dims = dims;
  }

  tolist(): number[] {
    return Array.from(this.data);
  }
}

vi.mock('workerpool', () => ({
  ['Transfer']: vi.fn(function TransferStub<T>(value: T) {
    return value;
  }),
  worker: vi.fn(),
  workerEmit: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  env: { allowRemoteModels: false },
  pipeline: async (...args: unknown[]) => attachStandInTokenizer(await pipelineMock(...args)),
  ['Tensor']: MockTensor,
}));

function forceGarbageCollection(): void {
  const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!collect) {
    throw new Error('BST-372 current retention regression requires Node --expose-gc.');
  }
  collect();
  collect();
}

function captureArrayBuffers(): number {
  return process.memoryUsage().arrayBuffers;
}

it('keeps 512 current-production maximum-dimension batches physically batch-bounded', async () => {
  const texts = Array.from({ length: INPUT_COUNT }, (_, index) => `document-${index}`);
  const messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  const arrayBufferSamples: number[] = [];
  let extractorCallCount = 0;
  let streamedBatchCount = 0;
  let streamedPayloadBytes = 0;
  let handleMessage: ((event: MessageEvent<unknown>) => void) | undefined;
  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;

  const postMessage = (message: unknown, transferList: readonly ArrayBuffer[] = []): void => {
    const event = message as {
      readonly batchIndex?: number;
      readonly id?: string;
      readonly message?: string;
      readonly type?: string;
    };
    if (event.type === 'batch') {
      if (event.id !== 'bst-372-current-retention' || event.batchIndex === undefined) {
        throw new Error('Current streaming worker emitted a malformed retention-test batch.');
      }
      streamedBatchCount += 1;
      streamedPayloadBytes += transferList.reduce((sum, buffer) => sum + buffer.byteLength, 0);
      arrayBufferSamples.push(captureArrayBuffers());
      queueMicrotask(() => {
        if (!handleMessage) {
          throw new Error('Current streaming worker message handler was not registered.');
        }
        handleMessage({
          data: {
            batchIndex: event.batchIndex,
            id: event.id,
            type: 'stream-ack',
          },
        } as MessageEvent<unknown>);
      });
      return;
    }
    if (event.type === 'complete') {
      resolveCompletion?.();
      return;
    }
    if (event.type === 'error') {
      rejectCompletion?.(new Error(event.message ?? 'Unknown current streaming worker error.'));
    }
  };

  vi.stubGlobal('self', {
    addEventListener: (type: string, listener: (event: MessageEvent<unknown>) => void) => {
      if (type === 'message') {
        messageListeners.add(listener);
      }
    },
    onerror: undefined,
    onunhandledrejection: undefined,
    postMessage,
  });

  pipelineMock.mockResolvedValue(async (slice: readonly string[]) => {
    forceGarbageCollection();
    arrayBufferSamples.push(captureArrayBuffers());
    extractorCallCount += 1;
    return slice.map(() => new Float32Array(MAX_EMBEDDING_DIMENSION).fill(1));
  });

  await import('../src/embedding.worker');
  forceGarbageCollection();
  const baselineArrayBuffers = captureArrayBuffers();
  arrayBufferSamples.push(baselineArrayBuffers);

  [handleMessage] = [...messageListeners];
  if (!handleMessage) {
    throw new Error('Current streaming worker message handler was not registered.');
  }
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  handleMessage({
    data: {
      request: {
        deviceHint: 'wasm',
        id: 'bst-372-current-retention',
        maxBatchSize: BATCH_SIZE,
        model: 'bge-m3',
        targetDimension: MAX_EMBEDDING_DIMENSION,
        texts,
        type: 'embed',
      },
      type: 'stream-embed',
    },
  } as MessageEvent<unknown>);
  await completion;
  forceGarbageCollection();
  arrayBufferSamples.push(captureArrayBuffers());

  const peakArrayBuffers = Math.max(...arrayBufferSamples);
  const peakArrayBufferDelta = peakArrayBuffers - baselineArrayBuffers;
  const expectedPayloadBytes = INPUT_COUNT * MAX_EMBEDDING_DIMENSION * 4;
  expect(extractorCallCount).toBe(EXPECTED_BATCH_COUNT);
  expect(streamedBatchCount).toBe(EXPECTED_BATCH_COUNT);
  expect(streamedPayloadBytes).toBe(expectedPayloadBytes);
  expect(peakArrayBufferDelta).toBeLessThanOrEqual(MAX_ARRAY_BUFFER_DELTA_BYTES);

  process.stdout.write(
    `BST372_CURRENT_RETENTION_RESULT ${JSON.stringify({
      batchPayloadBytes: BATCH_PAYLOAD_BYTES,
      dimensions: MAX_EMBEDDING_DIMENSION,
      expectedBatchCount: EXPECTED_BATCH_COUNT,
      inputCount: INPUT_COUNT,
      maxArrayBufferDeltaBytes: MAX_ARRAY_BUFFER_DELTA_BYTES,
      peakArrayBufferDeltaBytes: peakArrayBufferDelta,
      streamedPayloadBytes,
    })}\n`
  );
});
