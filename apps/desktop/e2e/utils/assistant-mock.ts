import type { Page } from '@playwright/test';

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-5.2',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-3-flash-preview',
  openrouter: 'openai/gpt-5.2',
} as const;

export interface AssistantMockOptions {
  readonly apiKey?: string;
  readonly errorMessage?: string;
  readonly message?: string;
  readonly models?: Record<string, string>;
  readonly provider?: string;
  readonly variant?: 'simple' | 'detailed' | 'tool' | 'tool-error' | 'stream-error';
}

interface AssistantMockInstallPayload {
  readonly models: Record<string, string>;
  readonly provider: string;
  readonly streamChunks: Array<{ delayMs: number; payload: string }>;
}

function installAssistantMockInPage(payload: AssistantMockInstallPayload): void {
  const globals = globalThis as unknown as Window & {
    __assistantMockApplied?: boolean;
    __assistantMockConfig?: AssistantMockInstallPayload;
    __assistantAvailabilityOverride?: { state: 'enabled' };
    fetch: typeof fetch;
    localStorage?: Storage;
    secrets?: {
      list?: () => Promise<string[]>;
      [key: string]: unknown;
    };
  };

  globals.__assistantMockConfig = payload;

  try {
    globals.localStorage?.setItem(
      'assistant-preferences.v1',
      JSON.stringify({
        state: {
          selectedProvider: 'openai',
          modelsByProvider: payload.models,
        },
        version: 1,
      })
    );
  } catch {
    // ignore storage errors in constrained environments
  }

  globals.__assistantAvailabilityOverride = { state: 'enabled' };
  globals.secrets = {
    ...globals.secrets,
    list: async () => [payload.provider],
  };

  if (globals.__assistantMockApplied) {
    return;
  }

  globals.__assistantMockApplied = true;

  const encoder = new TextEncoder();
  const originalFetch = globals.fetch.bind(globals);

  function createMockResponse(signal: AbortSignal | undefined): Response {
    const activeConfig = globals.__assistantMockConfig;
    if (!activeConfig) {
      throw new Error('Assistant mock config is unavailable.');
    }

    const streamChunks = activeConfig.streamChunks.map((chunk) => ({ ...chunk }));
    const chunkQueue = streamChunks.map((chunk) => ({ ...chunk }));
    let chunkIndex = 0;
    let aborted = false;

    const handleAbort = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.error(new DOMException('Aborted', 'AbortError'));
    };

    const processNextChunk = async (
      controller: ReadableStreamDefaultController<Uint8Array>
    ): Promise<void> => {
      const nextChunk = chunkQueue[chunkIndex++];
      if (!nextChunk) {
        return;
      }
      if (nextChunk.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, nextChunk.delayMs));
      }
      if (aborted) {
        handleAbort(controller);
        return;
      }

      controller.enqueue(encoder.encode(nextChunk.payload));
    };

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (aborted) {
          return handleAbort(controller);
        }
        if (chunkIndex >= chunkQueue.length) {
          controller.close();
          return;
        }
        await processNextChunk(controller);
      },
      cancel() {
        aborted = true;
      },
    });

    if (signal) {
      const onAbort = (): void => {
        aborted = true;
      };
      if (signal.aborted) {
        aborted = true;
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'x-vercel-ai-data-stream': 'v1',
      },
    });
  }

  globals.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);

    if (url.includes('/assistant/status') || url.endsWith('/status')) {
      return new Response(JSON.stringify({ enabled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    if (
      (url.includes('/assistant') || url.includes('/api/assistant')) &&
      (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'POST'
    ) {
      return createMockResponse(init?.signal ?? undefined);
    }

    return originalFetch(input, init);
  };
}

const defaultOptions: Required<AssistantMockOptions> = {
  provider: 'openai',
  apiKey: 'test-api-key-for-e2e-tests',
  message: 'Hello from desktop assistant!',
  errorMessage: 'Assistant request failed.',
  variant: 'simple',
  models: DEFAULT_MODELS,
};

function buildAssistantStreamChunks(options: Required<AssistantMockOptions>): Array<{
  delayMs: number;
  payload: string;
}> {
  const createToolCallId = (): string => `tool-${Date.now()}`;

  const chunks: Array<{ delayMs: number; payload: string }> = [];

  const enqueueChunk = (code: string, value: unknown, delayMs = 0): void => {
    chunks.push({ delayMs, payload: `${code}:${JSON.stringify(value)}\n` });
  };

  const writeAssistantText = (text: string): void => {
    enqueueChunk('0', text);
  };

  const writeFinish = (
    finishReason: 'stop' | 'error',
    usage: { completionTokens: number; promptTokens: number }
  ): void => {
    const dataStreamUsage = {
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
    };

    enqueueChunk('e', {
      finishReason,
      usage: dataStreamUsage,
      isContinued: false,
    });
    enqueueChunk('d', {
      finishReason,
      usage: dataStreamUsage,
      path: [],
    });
  };

  enqueueChunk('f', { messageId: `msg-${Date.now()}`, path: [] });

  switch (options.variant) {
    case 'stream-error':
      writeAssistantText(options.errorMessage);
      enqueueChunk('3', options.errorMessage);
      writeFinish('error', { promptTokens: 0, completionTokens: 0 });
      return chunks;
    case 'detailed':
      writeAssistantText(options.message);
      writeFinish('stop', { promptTokens: 5, completionTokens: 8 });
      return chunks;
    case 'tool': {
      const toolCallId = createToolCallId();
      const args = { query: 'mock retrieval query', limit: 3 };
      enqueueChunk('b', { toolCallId, toolName: 'brainstrike.retrieveContext' });
      enqueueChunk('c', { toolCallId, argsTextDelta: JSON.stringify(args) });
      enqueueChunk('9', {
        toolCallId,
        toolName: 'brainstrike.retrieveContext',
        args,
      });
      enqueueChunk('a', {
        toolCallId,
        result: {
          context: 'File: src/app.ts\nconst answer = 42;',
          chunks: [{ id: 'chunk-1', filePath: 'src/app.ts', chunkIndex: 0, tokenCount: 5 }],
        },
      });
      writeAssistantText(options.message);
      writeFinish('stop', { promptTokens: 5, completionTokens: 8 });
      return chunks;
    }
    case 'tool-error': {
      const toolCallId = createToolCallId();
      const args = { query: 'mock retrieval query', limit: 3 };
      enqueueChunk('b', { toolCallId, toolName: 'brainstrike.retrieveContext' });
      enqueueChunk('c', { toolCallId, argsTextDelta: JSON.stringify(args) });
      enqueueChunk('9', {
        toolCallId,
        toolName: 'brainstrike.retrieveContext',
        args,
      });
      enqueueChunk('a', {
        toolCallId,
        result: { error: options.errorMessage },
        isError: true,
      });
      writeAssistantText(options.errorMessage);
      writeFinish('stop', { promptTokens: 5, completionTokens: 8 });
      return chunks;
    }
    default:
      writeAssistantText(options.message);
      writeFinish('stop', { promptTokens: 10, completionTokens: 5 });
      return chunks;
  }
}

export async function setupAssistantMock(
  page: Page,
  options?: AssistantMockOptions
): Promise<void> {
  const merged = { ...defaultOptions, ...options };

  await page.evaluate(
    async ({ provider, apiKey }) => {
      const globals = globalThis as unknown as {
        secrets?: { saveKey?: (p: string, key: string) => Promise<unknown> };
      };
      await globals.secrets?.saveKey?.(provider, apiKey);
    },
    { provider: merged.provider, apiKey: merged.apiKey }
  );

  const installPayload: AssistantMockInstallPayload = {
    provider: merged.provider,
    models: merged.models,
    streamChunks: buildAssistantStreamChunks(merged),
  };

  await page.evaluate(installAssistantMockInPage, installPayload);

  await page.evaluate(() => {
    const testWindow = window as Window & {
      __brainstrikeAssistantRuntimeTestHooks__?: {
        setCurrentThreadModel: (compositeKey: string) => void;
      };
      __brainstrikeTestHooks__?: {
        notifySecretsChanged: () => void;
        setAssistantModel: (compositeKey: string) => void;
      };
    };
    const hooks = testWindow.__brainstrikeTestHooks__;
    const runtimeHooks = testWindow.__brainstrikeAssistantRuntimeTestHooks__;

    if (!hooks) {
      throw new Error('Brainstrike desktop test hooks are unavailable.');
    }

    hooks.notifySecretsChanged();
    hooks.setAssistantModel('openai::gpt-5.2');
    runtimeHooks?.setCurrentThreadModel('openai::gpt-5.2');
  });
}
