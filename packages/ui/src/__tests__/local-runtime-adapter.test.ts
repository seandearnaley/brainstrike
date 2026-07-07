import type { ChatModelRunOptions, ChatModelRunResult } from '@assistant-ui/react';
import type { LocalLlmBackend, LocalLlmGenerationResult } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalModelAdapter,
  disposeLocalBackend,
  getBestInferenceDevice,
  hasDesktopLlmHost,
  isLocalInferenceAvailable,
  warmDesktopLocalModel,
} from '../../src/assistant-ui-panel/local-runtime-adapter';

const { acquireBackgroundWorkPauseReasonMock, releaseBackgroundWorkPauseReasonMock } = vi.hoisted(
  () => ({
    acquireBackgroundWorkPauseReasonMock: vi.fn(),
    releaseBackgroundWorkPauseReasonMock: vi.fn(),
  })
);

vi.mock('@brainstrike/utils', () => ({
  acquireBackgroundWorkPauseReason: acquireBackgroundWorkPauseReasonMock,
}));

function createRunOptions(): ChatModelRunOptions {
  return {
    abortSignal: new AbortController().signal,
    context: {},
    messages: [
      {
        attachments: [],
        content: [{ text: 'Tell me a joke', type: 'text' }],
        createdAt: new Date('2026-04-10T00:00:00.000Z'),
        id: 'user-1',
        metadata: {
          custom: {},
        },
        role: 'user',
      },
    ],
    runConfig: {},
    unstable_getMessage() {
      throw new Error('not needed in local adapter tests');
    },
  };
}

function createGenerationResult(
  overrides: Partial<LocalLlmGenerationResult> = {}
): LocalLlmGenerationResult {
  return {
    finishReason: 'stop',
    reasoningText: 'Analyze request.\nSelect safe joke.\nPrepare answer.',
    text: 'Why do programmers prefer dark mode?\nBecause light attracts bugs.',
    usage: {
      completionTokens: 12,
      promptTokens: 8,
      totalTokens: 20,
    },
    ...overrides,
  };
}

async function collectRun(
  runResult: Promise<ChatModelRunResult> | AsyncGenerator<ChatModelRunResult, void>
): Promise<ChatModelRunResult[]> {
  if (!(Symbol.asyncIterator in runResult)) {
    return [await runResult];
  }

  const updates: ChatModelRunResult[] = [];
  for await (const update of runResult) {
    updates.push(update);
  }
  return updates;
}

describe('createLocalModelAdapter', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    releaseBackgroundWorkPauseReasonMock.mockReset();
    acquireBackgroundWorkPauseReasonMock.mockReset();
    acquireBackgroundWorkPauseReasonMock.mockResolvedValue(releaseBackgroundWorkPauseReasonMock);
  });

  afterEach(async () => {
    await disposeLocalBackend();
    vi.unstubAllGlobals();
    (window as Window & { llmHost?: unknown }).llmHost = undefined;
  });

  it('streams text snapshots and exposes reasoning as a separate part', async () => {
    let progressListener: ((progress: unknown) => void) | null = null;
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockImplementation(async ({ requestId }: { requestId?: string }) => {
      progressListener?.({
        payload: {
          clientRequestId: requestId,
          kind: 'stage',
          message: 'reasoning',
        },
        requestId: requestId ?? 'req-1',
        type: 'progress',
      });
      progressListener?.({
        payload: {
          clientRequestId: requestId,
          kind: 'reasoning',
          reasoningText: 'Analyze request.\nSelect safe joke.\nPrepare answer.',
        },
        requestId: requestId ?? 'req-1',
        type: 'progress',
      });
      progressListener?.({
        payload: {
          clientRequestId: requestId,
          kind: 'text',
          text: 'Why do programmers prefer dark mode?\nBecause light attracts bugs.',
        },
        requestId: requestId ?? 'req-1',
        type: 'progress',
      });
      return createGenerationResult();
    });
    const progress = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onLoadingProgress: progress,
      thinkingEnabled: true,
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    expect(warmup).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(acquireBackgroundWorkPauseReasonMock).toHaveBeenCalledWith('local-llm');
    expect(releaseBackgroundWorkPauseReasonMock).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: 'Starting local model host...',
        stage: 'loading',
      })
    );
    expect(progress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: 'Thinking...',
        stage: 'generating',
      })
    );
    expect(progress).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        message: 'Response complete.',
        stage: 'ready',
      })
    );

    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((update) => update.content?.some((part) => part.type === 'data'))).toBe(
      true
    );
    expect(updates).toContainEqual({
      content: expect.arrayContaining([
        {
          text: 'Analyze request.\nSelect safe joke.\nPrepare answer.',
          type: 'reasoning',
        },
      ]),
    });
    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        {
          text: 'Why do programmers prefer dark mode?\nBecause light attracts bugs.',
          type: 'text',
        },
      ]),
    });
  });

  it('invokes onActivity for streamed snapshots and survives hook failures', async () => {
    let progressListener: ((progress: unknown) => void) | null = null;
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockImplementation(async ({ requestId }: { requestId?: string }) => {
      progressListener?.({
        payload: {
          clientRequestId: requestId,
          kind: 'reasoning',
          reasoningText: 'Thinking about it.',
        },
        requestId: requestId ?? 'req-activity',
        type: 'progress',
      });
      progressListener?.({
        payload: {
          clientRequestId: requestId,
          kind: 'text',
          text: 'Here is the answer.',
        },
        requestId: requestId ?? 'req-activity',
        type: 'progress',
      });
      return createGenerationResult({ text: 'Here is the answer.' });
    });

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
        warmup,
      },
    });

    const onActivity = vi.fn(() => {
      throw new Error('activity hook failed');
    });
    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onActivity,
      thinkingEnabled: true,
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    // Both reasoning and text snapshots count as activity, and a throwing
    // hook must not break the stream.
    expect(onActivity.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        {
          text: 'Here is the answer.',
          type: 'text',
        },
      ]),
    });
  });

  it('completes prepared runtime data when a local run has no message content', async () => {
    const completeRuntimeData = vi.fn();
    const preparedRuntimeData = { memory: { runId: 'run-empty' } };
    const prepareRuntimeData = vi.fn(async () => preparedRuntimeData);
    const adapter = createLocalModelAdapter({
      completeRuntimeData,
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      prepareRuntimeData,
    });

    const updates = await collectRun(
      adapter.run({
        ...createRunOptions(),
        messages: [],
      })
    );

    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        {
          text: 'No message content to process.',
          type: 'text',
        },
      ]),
    });
    expect(completeRuntimeData).toHaveBeenCalledWith(preparedRuntimeData, 'completed');
  });

  it('loads the browser backend once and streams local generation snapshots', async () => {
    const initialize = vi.fn(
      async ({ onProgress }: Parameters<LocalLlmBackend['initialize']>[0]) => {
        onProgress?.({
          message: 'Loading browser Gemma runtime',
          progress: 33,
          stage: 'loading',
        });
      }
    );
    const generate = vi.fn(
      async (messages: Parameters<LocalLlmBackend['generate']>[0], options) => {
        expect(messages).toEqual([
          {
            content: 'Tell me a joke',
            role: 'user',
          },
        ]);
        options?.stream?.onStageChange?.('responding');
        options?.stream?.onReasoningSnapshot?.('Browser reasoning.');
        options?.stream?.onTextSnapshot?.('Browser stream text.');
        return createGenerationResult({
          reasoningText: 'Browser reasoning.',
          text: 'Browser final text.',
        });
      }
    );
    const backend = {
      dispose: vi.fn(async () => {}),
      generate,
      initialize,
      isReady: vi.fn(() => false),
    } satisfies LocalLlmBackend;
    const loadBackend = vi.fn(async () => backend);
    const progress = vi.fn();

    const adapter = createLocalModelAdapter({
      loadBackend,
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onLoadingProgress: progress,
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    expect(loadBackend).toHaveBeenCalledTimes(1);
    // The adapter wraps onLoadingProgress with the activity-renewal hook, so the
    // backend receives the wrapper, not the caller's function identity. The
    // forwarding behavior is asserted below via the progress payload.
    expect(initialize).toHaveBeenCalledWith({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onProgress: expect.any(Function),
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Loading browser Gemma runtime',
        progress: 33,
        stage: 'loading',
      })
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Generating answer...',
        stage: 'generating',
      })
    );
    expect(updates).toContainEqual({
      content: expect.arrayContaining([
        {
          text: 'Browser reasoning.',
          type: 'reasoning',
        },
        {
          text: 'Browser stream text.',
          type: 'text',
        },
      ]),
    });
    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        {
          text: 'Browser final text.',
          type: 'text',
        },
      ]),
    });
  });

  it('reuses an initialized browser backend for the same model until disposal', async () => {
    let ready = false;
    const backend = {
      dispose: vi.fn(async () => {
        ready = false;
      }),
      generate: vi.fn(async () => createGenerationResult({ text: 'Browser response.' })),
      initialize: vi.fn(async () => {
        ready = true;
      }),
      isReady: vi.fn(() => ready),
    } satisfies LocalLlmBackend;
    const loadBackend = vi.fn(async () => backend);

    const adapter = createLocalModelAdapter({
      loadBackend,
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });

    await collectRun(adapter.run(createRunOptions()));
    await collectRun(adapter.run(createRunOptions()));

    expect(loadBackend).toHaveBeenCalledTimes(1);
    expect(backend.initialize).toHaveBeenCalledTimes(1);
    expect(backend.generate).toHaveBeenCalledTimes(2);

    await disposeLocalBackend();

    expect(backend.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not re-warm an already warmed desktop model', async () => {
    let progressListener: ((progress: unknown) => void) | null = null;
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockImplementation(async ({ requestId }: { requestId?: string }) => {
      progressListener?.({
        payload: {
          clientRequestId: requestId,
          kind: 'text',
          text: 'Why do programmers prefer dark mode?\nBecause light attracts bugs.',
        },
        requestId: requestId ?? 'req-2',
        type: 'progress',
      });
      return createGenerationResult();
    });
    const progress = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onLoadingProgress: progress,
    });

    await collectRun(adapter.run(createRunOptions()));
    progress.mockClear();

    await collectRun(adapter.run(createRunOptions()));

    expect(warmup).toHaveBeenCalledTimes(1);
    expect(acquireBackgroundWorkPauseReasonMock).toHaveBeenCalledTimes(2);
    expect(releaseBackgroundWorkPauseReasonMock).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Response complete.',
        stage: 'ready',
      })
    );
  });

  it('uses clone-safe options for desktop generation and cancels through llmHost on abort', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn().mockResolvedValue(undefined);
    let resolveGeneration: ((value: LocalLlmGenerationResult) => void) | null = null;
    let markGenerateStarted: (() => void) | null = null;
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve;
    });
    const generate = vi
      .fn()
      .mockImplementation(async ({ options }: { options?: Record<string, unknown> }) => {
        expect(options?.['signal']).toBeUndefined();
        markGenerateStarted?.();
        return await new Promise<LocalLlmGenerationResult>((resolve) => {
          resolveGeneration = resolve;
        });
      });

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        cancel,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });
    const abortController = new AbortController();
    const run = collectRun(
      adapter.run({
        ...createRunOptions(),
        abortSignal: abortController.signal,
      })
    );

    await generateStarted;
    abortController.abort();
    const completeGeneration = resolveGeneration;
    if (typeof completeGeneration === 'function') {
      (completeGeneration as (value: LocalLlmGenerationResult) => void)(
        createGenerationResult({
          text: 'Partial response',
        })
      );
    }
    await run;

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('lets an aborted warmup caller exit locally without cancelling shared warmup work', async () => {
    const warmup = vi.fn().mockImplementation(async () => await new Promise<void>(() => {}));
    const cancel = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        cancel,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });
    const abortController = new AbortController();

    const updatesPromise = collectRun(
      adapter.run({
        ...createRunOptions(),
        abortSignal: abortController.signal,
      })
    );

    await vi.waitFor(() => {
      expect(warmup).toHaveBeenCalledTimes(1);
    });
    abortController.abort();

    await expect(updatesPromise).resolves.toContainEqual({
      content: expect.arrayContaining([{ text: 'Generation cancelled.', type: 'text' }]),
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('fails fast when the desktop llm host does not expose warmup', async () => {
    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate: vi.fn(),
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        {
          text: expect.stringContaining('Desktop llm host does not implement warmup.'),
          type: 'text',
        },
      ]),
    });
  });

  it('forwards warmup loading progress from the hidden llm host', async () => {
    let progressListener: ((progress: unknown) => void) | null = null;
    const warmup = vi.fn().mockImplementation(async ({ requestId }: { requestId?: string }) => {
      progressListener?.({
        payload: {
          clientRequestId: requestId,
          file: 'onnx/embed_tokens_q4f16.onnx',
          kind: 'loading',
          message: 'Downloading onnx/embed_tokens_q4f16.onnx',
          progress: 42,
        },
        requestId: requestId ?? 'warmup-req',
        type: 'progress',
      });
    });
    const generate = vi.fn().mockResolvedValue(createGenerationResult({ text: 'Loaded.' }));
    const progress = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onLoadingProgress: progress,
    });

    await collectRun(adapter.run(createRunOptions()));

    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'onnx/embed_tokens_q4f16.onnx',
        progress: 42,
        stage: 'loading',
      })
    );
  });

  it('renews activity from loading progress, not only generation snapshots', async () => {
    let progressListener: ((progress: unknown) => void) | null = null;
    const warmup = vi.fn().mockImplementation(async ({ requestId }: { requestId?: string }) => {
      progressListener?.({
        payload: {
          clientRequestId: requestId,
          file: 'onnx/embed_tokens_q4f16.onnx',
          kind: 'loading',
          message: 'Downloading onnx/embed_tokens_q4f16.onnx',
          progress: 42,
        },
        requestId: requestId ?? 'warmup-req',
        type: 'progress',
      });
    });
    const generate = vi.fn().mockResolvedValue(createGenerationResult({ text: 'Loaded.' }));
    const onActivity = vi.fn();
    // Snapshot the activity count at the moment the loading-progress callback
    // runs: generation snapshots happen later, so any renewals visible here can
    // only have come from the loading path itself. A first model download can
    // outlive the 5-minute foreground-activity fuse, so loading progress MUST
    // renew the lease or background indexing resumes mid-run.
    let activityCallsWhenProgressFired = -1;
    const progress = vi.fn(() => {
      activityCallsWhenProgressFired = onActivity.mock.calls.length;
    });

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onActivity,
      onLoadingProgress: progress,
    });

    await collectRun(adapter.run(createRunOptions()));

    expect(progress).toHaveBeenCalled();
    expect(activityCallsWhenProgressFired).toBeGreaterThanOrEqual(1);
  });

  it('re-warms the desktop model after the llm host reports an error state', async () => {
    let statusListener: ((status: { runtimeKind: 'llm-host'; state: string }) => void) | null =
      null;
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue(createGenerationResult({ text: 'Ready.' }));

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: (callback: (status: { runtimeKind: 'llm-host'; state: string }) => void) => {
          statusListener = callback;
          return () => {
            statusListener = null;
          };
        },
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });

    await collectRun(adapter.run(createRunOptions()));
    const reportStatus = statusListener;
    if (typeof reportStatus === 'function') {
      (reportStatus as (status: { runtimeKind: 'llm-host'; state: string }) => void)({
        runtimeKind: 'llm-host',
        state: 'error',
      });
    }
    await collectRun(adapter.run(createRunOptions()));

    expect(warmup).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent desktop warmup requests for the same model', async () => {
    let resolveWarmup: VoidFunction | undefined;
    const warmup = vi.fn().mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          resolveWarmup = resolve as VoidFunction;
        })
    );
    const generate = vi.fn().mockResolvedValue(createGenerationResult({ text: 'Ready.' }));

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });

    const firstRun = collectRun(adapter.run(createRunOptions()));
    const secondRun = collectRun(adapter.run(createRunOptions()));

    await vi.waitFor(() => {
      expect(warmup).toHaveBeenCalledTimes(1);
    });

    resolveWarmup?.();
    await Promise.all([firstRun, secondRun]);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent desktop local generations through a FIFO queue', async () => {
    const generationResolvers: Array<(value: LocalLlmGenerationResult) => void> = [];
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockImplementation(
      async () =>
        await new Promise<LocalLlmGenerationResult>((resolve) => {
          generationResolvers.push(resolve);
        })
    );

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });

    const firstRun = collectRun(adapter.run(createRunOptions()));
    const secondRun = collectRun(adapter.run(createRunOptions()));

    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1);
    });
    expect(generationResolvers).toHaveLength(1);

    generationResolvers[0]?.(createGenerationResult({ text: 'First response.' }));
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(2);
    });
    generationResolvers[1]?.(createGenerationResult({ text: 'Second response.' }));

    await expect(firstRun).resolves.toContainEqual({
      content: expect.arrayContaining([{ text: 'First response.', type: 'text' }]),
    });
    await expect(secondRun).resolves.toContainEqual({
      content: expect.arrayContaining([{ text: 'Second response.', type: 'text' }]),
    });
  });

  it('waits for in-flight local generation before completing backend disposal', async () => {
    const generationResolvers: Array<(value: LocalLlmGenerationResult) => void> = [];
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockImplementation(
      async () =>
        await new Promise<LocalLlmGenerationResult>((resolve) => {
          generationResolvers.push(resolve);
        })
    );

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });

    const firstRun = collectRun(adapter.run(createRunOptions()));
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1);
    });

    const disposal = disposeLocalBackend();
    let disposalResolved = false;
    disposal.then(() => {
      disposalResolved = true;
    });
    const secondRun = collectRun(adapter.run(createRunOptions()));
    await Promise.resolve();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(disposalResolved).toBe(false);

    generationResolvers[0]?.(createGenerationResult({ text: 'First response.' }));
    await firstRun;
    await disposal;

    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(2);
    });
    generationResolvers[1]?.(createGenerationResult({ text: 'Second response.' }));
    await expect(secondRun).resolves.toContainEqual({
      content: expect.arrayContaining([{ text: 'Second response.', type: 'text' }]),
    });
  });

  it('does not cancel a shared warmup when only a joiner aborts', async () => {
    let resolveWarmup: VoidFunction | undefined;
    const warmup = vi.fn().mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          resolveWarmup = resolve as VoidFunction;
        })
    );
    const cancel = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue(createGenerationResult({ text: 'Ready.' }));

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        cancel,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });
    const ownerAbort = new AbortController();
    const joinerAbort = new AbortController();

    const ownerRun = collectRun(
      adapter.run({
        ...createRunOptions(),
        abortSignal: ownerAbort.signal,
      })
    );
    const joinerRun = collectRun(
      adapter.run({
        ...createRunOptions(),
        abortSignal: joinerAbort.signal,
      })
    );

    await vi.waitFor(() => {
      expect(warmup).toHaveBeenCalledTimes(1);
    });
    joinerAbort.abort();
    resolveWarmup?.();

    await expect(joinerRun).resolves.toContainEqual({
      content: expect.arrayContaining([{ text: 'Generation cancelled.', type: 'text' }]),
    });
    await expect(ownerRun).resolves.toContainEqual({
      content: expect.arrayContaining([{ text: 'Ready.', type: 'text' }]),
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('keeps a shared warmup alive when the owner aborts and a joiner is still waiting', async () => {
    const warmupResolvers: VoidFunction[] = [];
    const warmup = vi.fn().mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          warmupResolvers.push(resolve as VoidFunction);
        })
    );
    const cancel = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue(createGenerationResult({ text: 'Ready.' }));

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        cancel,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });
    const ownerAbort = new AbortController();
    const joinerAbort = new AbortController();

    const ownerRun = collectRun(
      adapter.run({
        ...createRunOptions(),
        abortSignal: ownerAbort.signal,
      })
    );
    const joinerRun = collectRun(
      adapter.run({
        ...createRunOptions(),
        abortSignal: joinerAbort.signal,
      })
    );

    await vi.waitFor(() => {
      expect(warmup).toHaveBeenCalledTimes(1);
    });
    ownerAbort.abort();

    await expect(ownerRun).resolves.toContainEqual({
      content: expect.arrayContaining([{ text: 'Generation cancelled.', type: 'text' }]),
    });
    expect(cancel).not.toHaveBeenCalled();
    warmupResolvers.at(-1)?.();

    await expect(joinerRun).resolves.toContainEqual({
      content: expect.arrayContaining([{ text: 'Ready.', type: 'text' }]),
    });
    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('reports a terminal ready state after a successful warm run', async () => {
    let progressListener: ((progress: unknown) => void) | null = null;
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockImplementation(async ({ requestId }: { requestId?: string }) => {
      progressListener?.({
        payload: {
          clientRequestId: requestId,
          kind: 'stage',
          message: 'responding',
        },
        requestId: requestId ?? 'req-3',
        type: 'progress',
      });
      progressListener?.({
        payload: {
          clientRequestId: requestId,
          kind: 'text',
          text: 'Finished response.',
        },
        requestId: requestId ?? 'req-3',
        type: 'progress',
      });
      return createGenerationResult({
        text: 'Finished response.',
      });
    });
    const progress = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onLoadingProgress: progress,
    });

    await collectRun(adapter.run(createRunOptions()));
    progress.mockClear();

    await collectRun(adapter.run(createRunOptions()));

    expect(warmup).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Response complete.',
        stage: 'ready',
      })
    );
  });

  it('preserves tool calls alongside hidden reasoning content', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        createGenerationResult({
          text: '',
          toolCalls: [
            {
              function: {
                arguments: JSON.stringify({ topic: 'bugs' }),
                name: 'tell_joke',
              },
              id: 'tool-1',
              type: 'function',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        createGenerationResult({
          text: 'Here is a bugs joke.',
        })
      );
    const execute = vi.fn().mockResolvedValue({
      durationMs: 7,
      result: {
        joke: 'bugs',
      },
      success: true,
    });

    Object.assign(window as Window & { llmHost?: unknown; tools?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        warmup: vi.fn().mockResolvedValue(undefined),
      },
      tools: {
        execute,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      tools: [
        {
          description: 'Return a joke',
          id: 'tell_joke',
          inputSchema: {
            properties: {
              topic: { type: 'string' },
            },
            required: ['topic'],
            type: 'object',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    expect(execute).toHaveBeenCalledWith('tell_joke', { topic: 'bugs' }, undefined);
    expect(updates.length).toBeGreaterThanOrEqual(3);
    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        {
          text: 'Here is a bugs joke.',
          type: 'text',
        },
      ]),
    });
  });

  it('executes local tool calls and continues generation with tool results', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        createGenerationResult({
          reasoningText: 'Need to read the workspace file before answering.',
          text: '',
          toolCalls: [
            {
              function: {
                arguments: JSON.stringify({ path: '/README.md' }),
                name: 'filesystem.read_file',
              },
              id: 'tool-1',
              type: 'function',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        createGenerationResult({
          reasoningText: 'Summarize the tool result.',
          text: 'The README says hello.',
        })
      );
    const execute = vi.fn().mockResolvedValue({
      durationMs: 12,
      result: {
        content: 'hello',
      },
      success: true,
    });

    Object.assign(window as Window & { llmHost?: unknown; tools?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        warmup,
      },
      tools: {
        execute,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      runtimeData: {
        workspaceRootPath: '/tmp/test-workspace',
      },
      tools: [
        {
          description: 'Read a file',
          id: 'filesystem.read_file',
          inputSchema: {
            properties: {
              path: {
                description: 'Workspace-relative path',
                type: 'string',
              },
            },
            required: ['path'],
            type: 'object',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    expect(warmup).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      'filesystem.read_file',
      { path: '/README.md' },
      {
        workspaceRootPath: '/tmp/test-workspace',
      }
    );
    expect(generate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        options: expect.objectContaining({
          tools: [
            {
              function: {
                description: 'Read a file',
                name: 'filesystem.read_file',
                parameters: {
                  properties: {
                    path: {
                      description: 'Workspace-relative path',
                      type: 'string',
                    },
                  },
                  required: ['path'],
                  type: 'object',
                },
              },
              type: 'function',
            },
          ],
        }),
      })
    );
    expect(generate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            toolCalls: [
              expect.objectContaining({
                function: expect.objectContaining({
                  name: 'filesystem.read_file',
                }),
              }),
            ],
          }),
          expect.objectContaining({
            role: 'tool',
            toolResponses: [
              expect.objectContaining({
                name: 'filesystem.read_file',
                response: {
                  content: 'hello',
                },
              }),
            ],
          }),
        ]),
      })
    );

    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          result: {
            content: 'hello',
          },
          toolName: 'filesystem.read_file',
          type: 'tool-call',
        }),
        expect.objectContaining({
          text: 'The README says hello.',
          type: 'text',
        }),
      ]),
    });
  });

  it('reports why local tools are unavailable when the model returns a tool call', async () => {
    const generate = vi.fn().mockResolvedValue(
      createGenerationResult({
        reasoningText: 'Need a tool.',
        text: '',
        toolCalls: [
          {
            function: {
              arguments: '{}',
              name: 'brainstrike.listWorkspaceContext',
            },
            id: 'tool-1',
            type: 'function',
          },
        ],
      })
    );

    Object.assign(window as Window & { llmHost?: unknown; tools?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        warmup: vi.fn().mockResolvedValue(undefined),
      },
      tools: undefined,
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      tools: [
        {
          description: 'List workspace context',
          id: 'brainstrike.listWorkspaceContext',
          inputSchema: {
            properties: {},
            type: 'object',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    expect(updates.at(-1)).toMatchObject(
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining(
              'window.tools.execute is not available in the renderer preload bridge'
            ),
            type: 'text',
          }),
        ]),
      })
    );
  });

  it('normalizes runnable local tool schemas before browser generation', async () => {
    let ready = false;
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        createGenerationResult({
          text: '',
          toolCalls: [
            {
              function: {
                arguments: JSON.stringify({ query: 'coverage', tags: ['unit'] }),
                name: 'brainstrike.search_notes',
              },
              id: 'tool-schema-1',
              type: 'function',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        createGenerationResult({
          text: 'Found coverage notes.',
        })
      );
    const backend = {
      dispose: vi.fn(async () => {
        ready = false;
      }),
      generate,
      initialize: vi.fn(async () => {
        ready = true;
      }),
      isReady: vi.fn(() => ready),
    } satisfies LocalLlmBackend;
    const execute = vi.fn().mockResolvedValue({
      durationMs: 3,
      result: {
        matches: 2,
      },
      success: true,
    });

    Object.assign(window as Window & { tools?: unknown }, {
      tools: {
        execute,
      },
    });

    const adapter = createLocalModelAdapter({
      loadBackend: vi.fn(async () => backend),
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      tools: [
        {
          description: 'Search workspace notes',
          id: 'brainstrike.search_notes',
          inputSchema: {
            properties: {
              ignoredWithoutType: {
                description: 'Not a valid JSON schema property',
              },
              query: {
                description: 'Search query',
                enum: ['coverage', 'vitest'],
                type: 'string',
              },
              tags: {
                description: 'Filter tags',
                items: {
                  description: 'Tag value',
                  type: 'string',
                },
                type: 'array',
              },
            },
            required: ['query', 'tags'],
            type: 'object',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    expect(generate).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      expect.objectContaining({
        tools: [
          {
            function: {
              description: 'Search workspace notes',
              name: 'brainstrike.search_notes',
              parameters: {
                properties: {
                  query: {
                    description: 'Search query',
                    enum: ['coverage', 'vitest'],
                    type: 'string',
                  },
                  tags: {
                    description: 'Filter tags',
                    items: {
                      description: 'Tag value',
                      type: 'string',
                    },
                    type: 'array',
                  },
                },
                required: ['query', 'tags'],
                type: 'object',
              },
            },
            type: 'function',
          },
        ],
      })
    );
    expect(execute).toHaveBeenCalledWith(
      'brainstrike.search_notes',
      { query: 'coverage', tags: ['unit'] },
      undefined
    );
    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          text: 'Found coverage notes.',
          type: 'text',
        }),
      ]),
    });
  });

  it.each([
    {
      expectedReason: 'no tool menu was provided to the local runtime adapter',
      name: 'missing tool menu',
      tools: undefined,
    },
    {
      expectedReason: 'the tool menu is empty',
      name: 'empty tool menu',
      tools: [],
    },
    {
      expectedReason: 'all 1 configured tools are disabled',
      name: 'disabled tools',
      tools: [
        {
          enabled: false,
          id: 'brainstrike.disabled',
          inputSchema: {
            type: 'object',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
    },
    {
      expectedReason:
        '1 enabled tools are present, but none are marked runnable by the local runtime',
      name: 'non-runnable tools',
      tools: [
        {
          id: 'brainstrike.not_runnable',
          inputSchema: {
            type: 'object',
          },
          isLocalRuntimeRunnable: false,
        },
      ],
    },
    {
      expectedReason: '1 runnable tools are present, but none have an object JSON schema',
      name: 'tools without object schemas',
      tools: [
        {
          id: 'brainstrike.bad_schema',
          inputSchema: {
            type: 'string',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
    },
  ])('reports unavailable local tool reason for $name', async ({ expectedReason, tools }) => {
    const generate = vi.fn().mockResolvedValue(
      createGenerationResult({
        text: '',
        toolCalls: [
          {
            function: {
              arguments: '{}',
              name: 'brainstrike.missing',
            },
            id: 'tool-unavailable-1',
            type: 'function',
          },
        ],
      })
    );
    const backend = {
      dispose: vi.fn(async () => {}),
      generate,
      initialize: vi.fn(async () => {}),
      isReady: vi.fn(() => false),
    } satisfies LocalLlmBackend;
    const onError = vi.fn();

    Object.assign(window as Window & { tools?: unknown }, {
      tools: {
        execute: vi.fn(),
      },
    });

    const adapter = createLocalModelAdapter({
      loadBackend: vi.fn(async () => backend),
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onError,
      ...(tools === undefined ? {} : { tools }),
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(expectedReason),
      })
    );
    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining(expectedReason),
          type: 'text',
        }),
      ]),
    });
  });

  it('keeps non-object tool-call arguments out of assistant-ui args', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        createGenerationResult({
          text: '',
          toolCalls: [
            {
              function: {
                arguments: '["array input"]',
                name: 'brainstrike.echo',
              },
              id: 'tool-array-args',
              type: 'function',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        createGenerationResult({
          text: 'Array input handled.',
        })
      );
    const backend = {
      dispose: vi.fn(async () => {}),
      generate,
      initialize: vi.fn(async () => {}),
      isReady: vi.fn(() => false),
    } satisfies LocalLlmBackend;
    const execute = vi.fn().mockResolvedValue({
      durationMs: 1,
      result: {
        echoed: true,
      },
      success: true,
    });

    Object.assign(window as Window & { tools?: unknown }, {
      tools: {
        execute,
      },
    });

    const adapter = createLocalModelAdapter({
      loadBackend: vi.fn(async () => backend),
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      tools: [
        {
          id: 'brainstrike.echo',
          inputSchema: {
            type: 'object',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    expect(execute).toHaveBeenCalledWith('brainstrike.echo', ['array input'], undefined);
    expect(updates).toContainEqual({
      content: expect.arrayContaining([
        expect.objectContaining({
          args: {},
          argsText: '["array input"]',
          result: {
            echoed: true,
          },
          toolCallId: 'tool-array-args',
          toolName: 'brainstrike.echo',
          type: 'tool-call',
        }),
      ]),
    });
  });

  it('feeds only structured tool output back into the model after a tool failure', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        createGenerationResult({
          text: '',
          toolCalls: [
            {
              function: {
                arguments: JSON.stringify({ path: '/missing.md' }),
                name: 'filesystem.read_file',
              },
              id: 'tool-2',
              type: 'function',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        createGenerationResult({
          text: 'The file could not be read.',
        })
      );
    const execute = vi.fn().mockResolvedValue({
      durationMs: 5,
      error: 'missing',
      success: false,
    });

    Object.assign(window as Window & { llmHost?: unknown; tools?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        warmup: vi.fn().mockResolvedValue(undefined),
      },
      tools: {
        execute,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      tools: [
        {
          description: 'Read a file',
          id: 'filesystem.read_file',
          inputSchema: {
            properties: {
              path: {
                type: 'string',
              },
            },
            required: ['path'],
            type: 'object',
          },
          isLocalRuntimeRunnable: true,
        },
      ],
    });

    await collectRun(adapter.run(createRunOptions()));

    expect(generate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolResponses: [
              expect.objectContaining({
                name: 'filesystem.read_file',
                response: {
                  error: 'missing',
                },
              }),
            ],
          }),
        ]),
      })
    );
  });

  it('reports local inference availability from navigator.gpu', () => {
    expect(isLocalInferenceAvailable()).toBe(false);
    expect(getBestInferenceDevice()).toBeNull();

    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {},
    });

    expect(isLocalInferenceAvailable()).toBe(true);
    expect(getBestInferenceDevice()).toBe('webgpu');
  });

  it('calls onUsage with mapped inputTokens/outputTokens after desktop generation completes', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue(
      createGenerationResult({
        text: 'Token-counted answer.',
        usage: { completionTokens: 20, promptTokens: 50, totalTokens: 70 },
      })
    );
    const onUsage = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onUsage,
    });

    await collectRun(adapter.run(createRunOptions()));

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 50, outputTokens: 20 });
  });

  it('calls onUsage after browser backend generation completes', async () => {
    const backend = {
      dispose: vi.fn(async () => {}),
      generate: vi.fn(async () =>
        createGenerationResult({
          text: 'Browser token-counted answer.',
          usage: { completionTokens: 20, promptTokens: 50, totalTokens: 70 },
        })
      ),
      initialize: vi.fn(async () => {}),
      isReady: vi.fn(() => false),
    } satisfies LocalLlmBackend;
    const onUsage = vi.fn();

    const adapter = createLocalModelAdapter({
      loadBackend: vi.fn(async () => backend),
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onUsage,
    });

    await collectRun(adapter.run(createRunOptions()));

    expect(backend.generate).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 50, outputTokens: 20 });
  });

  it('calls onUsage with the last generation result usage in a tool-call turn (desktop)', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        createGenerationResult({
          text: '',
          toolCalls: [
            {
              function: {
                arguments: '{}',
                name: 'brainstrike.echo',
              },
              id: 'tool-usage-1',
              type: 'function',
            },
          ],
          usage: { completionTokens: 10, promptTokens: 30, totalTokens: 40 },
        })
      )
      .mockResolvedValueOnce(
        createGenerationResult({
          text: 'Final answer after tool.',
          usage: { completionTokens: 25, promptTokens: 60, totalTokens: 85 },
        })
      );
    const execute = vi.fn().mockResolvedValue({ durationMs: 1, result: 'ok', success: true });
    const onUsage = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown; tools?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
      tools: { execute },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onUsage,
      tools: [
        {
          id: 'brainstrike.echo',
          inputSchema: { properties: {}, type: 'object' },
          isLocalRuntimeRunnable: true,
        },
      ],
    });

    await collectRun(adapter.run(createRunOptions()));

    // Only the LAST generation's usage is reported — the final turn's prompt
    // reflects the accumulated context including tool results, which is the
    // most accurate usage for the one-turn-lag meter.
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 60, outputTokens: 25 });
  });

  it('does not call onUsage when no callback is provided', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue(
      createGenerationResult({
        text: 'Answer without usage callback.',
        usage: { completionTokens: 5, promptTokens: 10, totalTokens: 15 },
      })
    );

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    // No onUsage provided — must not throw
    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    });

    await expect(collectRun(adapter.run(createRunOptions()))).resolves.toBeDefined();
  });

  it('skips onUsage when the generation result has no usage field', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    // `usage` is optional at the IPC boundary: a host implementation may omit
    // it, and the adapter must skip the callback rather than report garbage.
    const resultWithoutUsage: LocalLlmGenerationResult = {
      finishReason: 'stop',
      text: 'Answer without usage data.',
    };
    const generate = vi.fn().mockResolvedValue(resultWithoutUsage);
    const onUsage = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        warmup,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onUsage,
    });

    const updates = await collectRun(adapter.run(createRunOptions()));

    expect(onUsage).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        {
          text: 'Answer without usage data.',
          type: 'text',
        },
      ]),
    });
  });
});

describe('desktop llm-host helpers for the data-stream local transport', () => {
  afterEach(() => {
    (window as Window & { llmHost?: unknown }).llmHost = undefined;
  });

  it('hasDesktopLlmHost reflects the preload bridge presence', () => {
    (window as Window & { llmHost?: unknown }).llmHost = undefined;
    expect(hasDesktopLlmHost()).toBe(false);

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: { warmup: vi.fn() },
    });
    expect(hasDesktopLlmHost()).toBe(true);
  });

  it('warmDesktopLocalModel warms via the bridge and surfaces loading progress', async () => {
    let progressListener: ((progress: unknown) => void) | null = null;
    const warmup = vi
      .fn()
      .mockImplementation(({ requestId }: { modelId: string; requestId: string }) => {
        progressListener?.({
          payload: {
            clientRequestId: requestId,
            file: 'model.onnx',
            kind: 'loading',
            message: 'Downloading model',
            progress: 40,
          },
          requestId,
          type: 'progress',
        });
        return Promise.resolve();
      });
    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
        onStatus: () => () => {},
        warmup,
      },
    });

    const onLoadingProgress = vi.fn();
    await warmDesktopLocalModel({
      modelId: 'warm-helper-model-a',
      onLoadingProgress,
    });

    expect(warmup).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'warm-helper-model-a' })
    );
    expect(onLoadingProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'model.onnx',
        message: 'Downloading model',
        progress: 40,
        stage: 'loading',
      })
    );
  });

  it('warmDesktopLocalModel throws when the bridge is unavailable', async () => {
    (window as Window & { llmHost?: unknown }).llmHost = undefined;
    await expect(warmDesktopLocalModel({ modelId: 'warm-helper-model-b' })).rejects.toThrow(
      'Desktop llm host bridge is unavailable'
    );
  });
});
