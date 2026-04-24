import type { ChatModelRunOptions, ChatModelRunResult } from '@assistant-ui/react';
import type { LocalLlmGenerationResult } from '@brainstrike/agent/local-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalModelAdapter,
  disposeLocalBackend,
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
    messages: [
      {
        id: 'user-1',
        role: 'user',
        createdAt: new Date('2026-04-10T00:00:00.000Z'),
        content: [{ type: 'text', text: 'Tell me a joke' }],
        attachments: [],
        metadata: {
          custom: {},
        },
      },
    ],
    runConfig: {},
    abortSignal: new AbortController().signal,
    context: {},
    config: {},
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
    text: 'Why do programmers prefer dark mode?\nBecause light attracts bugs.',
    reasoningText: 'Analyze request.\nSelect safe joke.\nPrepare answer.',
    usage: {
      promptTokens: 8,
      completionTokens: 12,
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
        type: 'progress',
        requestId: requestId ?? 'req-1',
        payload: {
          clientRequestId: requestId,
          kind: 'stage',
          message: 'reasoning',
        },
      });
      progressListener?.({
        type: 'progress',
        requestId: requestId ?? 'req-1',
        payload: {
          clientRequestId: requestId,
          kind: 'reasoning',
          reasoningText: 'Analyze request.\nSelect safe joke.\nPrepare answer.',
        },
      });
      progressListener?.({
        type: 'progress',
        requestId: requestId ?? 'req-1',
        payload: {
          clientRequestId: requestId,
          kind: 'text',
          text: 'Why do programmers prefer dark mode?\nBecause light attracts bugs.',
        },
      });
      return createGenerationResult();
    });
    const progress = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        warmup,
        generate,
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
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
        stage: 'loading',
        message: 'Starting local model host...',
      })
    );
    expect(progress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        stage: 'generating',
        message: 'Thinking...',
      })
    );
    expect(progress).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        stage: 'ready',
        message: 'Response complete.',
      })
    );

    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((update) => update.content?.some((part) => part.type === 'data'))).toBe(
      true
    );
    expect(updates).toContainEqual({
      content: expect.arrayContaining([
        {
          type: 'reasoning',
          text: 'Analyze request.\nSelect safe joke.\nPrepare answer.',
        },
      ]),
    });
    expect(updates.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        {
          type: 'text',
          text: 'Why do programmers prefer dark mode?\nBecause light attracts bugs.',
        },
      ]),
    });
  });

  it('does not re-warm an already warmed desktop model', async () => {
    let progressListener: ((progress: unknown) => void) | null = null;
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockImplementation(async ({ requestId }: { requestId?: string }) => {
      progressListener?.({
        type: 'progress',
        requestId: requestId ?? 'req-2',
        payload: {
          clientRequestId: requestId,
          kind: 'text',
          text: 'Why do programmers prefer dark mode?\nBecause light attracts bugs.',
        },
      });
      return createGenerationResult();
    });
    const progress = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        warmup,
        generate,
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
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
        stage: 'ready',
        message: 'Response complete.',
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
        warmup,
        cancel,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
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
        warmup,
        cancel,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
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
      content: expect.arrayContaining([{ type: 'text', text: 'Generation cancelled.' }]),
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
          type: 'text',
          text: expect.stringContaining('Desktop llm host does not implement warmup.'),
        },
      ]),
    });
  });

  it('forwards warmup loading progress from the hidden llm host', async () => {
    let progressListener: ((progress: unknown) => void) | null = null;
    const warmup = vi.fn().mockImplementation(async ({ requestId }: { requestId?: string }) => {
      progressListener?.({
        type: 'progress',
        requestId: requestId ?? 'warmup-req',
        payload: {
          clientRequestId: requestId,
          kind: 'loading',
          message: 'Downloading onnx/embed_tokens_q4f16.onnx',
          progress: 42,
          file: 'onnx/embed_tokens_q4f16.onnx',
        },
      });
    });
    const generate = vi.fn().mockResolvedValue(createGenerationResult({ text: 'Loaded.' }));
    const progress = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        warmup,
        generate,
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
        onStatus: vi.fn(() => () => {}),
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      onLoadingProgress: progress,
    });

    await collectRun(adapter.run(createRunOptions()));

    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loading',
        progress: 42,
        file: 'onnx/embed_tokens_q4f16.onnx',
      })
    );
  });

  it('re-warms the desktop model after the llm host reports an error state', async () => {
    let statusListener: ((status: { runtimeKind: 'llm-host'; state: string }) => void) | null =
      null;
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue(createGenerationResult({ text: 'Ready.' }));

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        warmup,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: (callback: (status: { runtimeKind: 'llm-host'; state: string }) => void) => {
          statusListener = callback;
          return () => {
            statusListener = null;
          };
        },
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
        warmup,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
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
        warmup,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
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
      content: expect.arrayContaining([{ type: 'text', text: 'First response.' }]),
    });
    await expect(secondRun).resolves.toContainEqual({
      content: expect.arrayContaining([{ type: 'text', text: 'Second response.' }]),
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
        warmup,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
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
      content: expect.arrayContaining([{ type: 'text', text: 'Second response.' }]),
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
        warmup,
        cancel,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
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
      content: expect.arrayContaining([{ type: 'text', text: 'Generation cancelled.' }]),
    });
    await expect(ownerRun).resolves.toContainEqual({
      content: expect.arrayContaining([{ type: 'text', text: 'Ready.' }]),
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
        warmup,
        cancel,
        generate,
        onProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
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
      content: expect.arrayContaining([{ type: 'text', text: 'Generation cancelled.' }]),
    });
    expect(cancel).not.toHaveBeenCalled();
    warmupResolvers.at(-1)?.();

    await expect(joinerRun).resolves.toContainEqual({
      content: expect.arrayContaining([{ type: 'text', text: 'Ready.' }]),
    });
    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('reports a terminal ready state after a successful warm run', async () => {
    let progressListener: ((progress: unknown) => void) | null = null;
    const warmup = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockImplementation(async ({ requestId }: { requestId?: string }) => {
      progressListener?.({
        type: 'progress',
        requestId: requestId ?? 'req-3',
        payload: {
          clientRequestId: requestId,
          kind: 'stage',
          message: 'responding',
        },
      });
      progressListener?.({
        type: 'progress',
        requestId: requestId ?? 'req-3',
        payload: {
          clientRequestId: requestId,
          kind: 'text',
          text: 'Finished response.',
        },
      });
      return createGenerationResult({
        text: 'Finished response.',
      });
    });
    const progress = vi.fn();

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: {
        warmup,
        generate,
        onProgress: (callback: (progress: unknown) => void) => {
          progressListener = callback;
          return () => {
            progressListener = null;
          };
        },
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
        stage: 'ready',
        message: 'Response complete.',
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
              id: 'tool-1',
              type: 'function',
              function: {
                name: 'tell_joke',
                arguments: JSON.stringify({ topic: 'bugs' }),
              },
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
      success: true,
      result: {
        joke: 'bugs',
      },
      durationMs: 7,
    });

    Object.assign(window as Window & { llmHost?: unknown; tools?: unknown }, {
      llmHost: {
        warmup: vi.fn().mockResolvedValue(undefined),
        generate,
        onProgress: vi.fn(() => () => {}),
      },
      tools: {
        execute,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      tools: [
        {
          id: 'tell_joke',
          description: 'Return a joke',
          inputSchema: {
            type: 'object',
            properties: {
              topic: { type: 'string' },
            },
            required: ['topic'],
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
          type: 'text',
          text: 'Here is a bugs joke.',
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
          text: '',
          reasoningText: 'Need to read the workspace file before answering.',
          toolCalls: [
            {
              id: 'tool-1',
              type: 'function',
              function: {
                name: 'filesystem.read_file',
                arguments: JSON.stringify({ path: '/README.md' }),
              },
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        createGenerationResult({
          text: 'The README says hello.',
          reasoningText: 'Summarize the tool result.',
        })
      );
    const execute = vi.fn().mockResolvedValue({
      success: true,
      result: {
        content: 'hello',
      },
      durationMs: 12,
    });

    Object.assign(window as Window & { llmHost?: unknown; tools?: unknown }, {
      llmHost: {
        warmup,
        generate,
        onProgress: vi.fn(() => () => {}),
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
          id: 'filesystem.read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Workspace-relative path',
              },
            },
            required: ['path'],
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
              type: 'function',
              function: {
                name: 'filesystem.read_file',
                description: 'Read a file',
                parameters: {
                  type: 'object',
                  properties: {
                    path: {
                      type: 'string',
                      description: 'Workspace-relative path',
                    },
                  },
                  required: ['path'],
                },
              },
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
          type: 'tool-call',
          toolName: 'filesystem.read_file',
          result: {
            content: 'hello',
          },
        }),
        expect.objectContaining({
          type: 'text',
          text: 'The README says hello.',
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
              id: 'tool-2',
              type: 'function',
              function: {
                name: 'filesystem.read_file',
                arguments: JSON.stringify({ path: '/missing.md' }),
              },
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
      success: false,
      error: 'missing',
      durationMs: 5,
    });

    Object.assign(window as Window & { llmHost?: unknown; tools?: unknown }, {
      llmHost: {
        warmup: vi.fn().mockResolvedValue(undefined),
        generate,
        onProgress: vi.fn(() => () => {}),
      },
      tools: {
        execute,
      },
    });

    const adapter = createLocalModelAdapter({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      tools: [
        {
          id: 'filesystem.read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
              },
            },
            required: ['path'],
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
});
