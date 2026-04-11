import type { ChatModelRunOptions, ChatModelRunResult } from '@assistant-ui/react';
import type { LocalLlmGenerationResult } from '@brainstrike/agent/local-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalModelAdapter,
  disposeLocalBackend,
} from '../../src/assistant-ui-panel/local-runtime-adapter';

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
    expect(updates[0]).toMatchObject({
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
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'ready',
        message: 'Response complete.',
      })
    );
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
                  success: true,
                  result: {
                    content: 'hello',
                  },
                  durationMs: 12,
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
});
