import type { Page } from '@playwright/test';

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-3.5-flash',
  openai: 'gpt-5.4',
  openrouter: 'openai/gpt-5.4',
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
  const assistantAvailabilityOverrideEvent = 'brainstrike:assistant-availability-override-changed';
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
          modelsByProvider: payload.models,
          selectedProvider: 'openai',
        },
        version: 1,
      })
    );
  } catch {
    // ignore storage errors in constrained environments
  }

  globals.__assistantAvailabilityOverride = { state: 'enabled' };
  globals.dispatchEvent(new Event(assistantAvailabilityOverrideEvent));
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
      cancel() {
        aborted = true;
      },
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
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'x-vercel-ai-data-stream': 'v1',
      },
      status: 200,
    });
  }

  globals.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);

    if (url.includes('/assistant/status') || url.endsWith('/status')) {
      return new Response(JSON.stringify({ enabled: true }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        status: 200,
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
  apiKey: 'test-api-key-for-e2e-tests',
  errorMessage: 'Assistant request failed.',
  message: 'Hello from desktop assistant!',
  models: DEFAULT_MODELS,
  provider: 'openai',
  variant: 'simple',
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
      isContinued: false,
      usage: dataStreamUsage,
    });
    enqueueChunk('d', {
      finishReason,
      path: [],
      usage: dataStreamUsage,
    });
  };

  enqueueChunk('f', { messageId: `msg-${Date.now()}`, path: [] });

  switch (options.variant) {
    case 'stream-error':
      writeAssistantText(options.errorMessage);
      enqueueChunk('3', options.errorMessage);
      writeFinish('error', { completionTokens: 0, promptTokens: 0 });
      return chunks;
    case 'detailed':
      writeAssistantText(options.message);
      writeFinish('stop', { completionTokens: 8, promptTokens: 5 });
      return chunks;
    case 'tool': {
      const toolCallId = createToolCallId();
      const args = { limit: 3, query: 'mock retrieval query' };
      enqueueChunk('b', { toolCallId, toolName: 'brainstrike.retrieveContext' });
      enqueueChunk('c', { argsTextDelta: JSON.stringify(args), toolCallId });
      enqueueChunk('9', {
        args,
        toolCallId,
        toolName: 'brainstrike.retrieveContext',
      });
      enqueueChunk('a', {
        result: {
          chunks: [{ chunkIndex: 0, filePath: 'src/app.ts', id: 'chunk-1', tokenCount: 5 }],
          context: 'File: src/app.ts\nconst answer = 42;',
        },
        toolCallId,
      });
      writeAssistantText(options.message);
      writeFinish('stop', { completionTokens: 8, promptTokens: 5 });
      return chunks;
    }
    case 'tool-error': {
      const toolCallId = createToolCallId();
      const args = { limit: 3, query: 'mock retrieval query' };
      enqueueChunk('b', { toolCallId, toolName: 'brainstrike.retrieveContext' });
      enqueueChunk('c', { argsTextDelta: JSON.stringify(args), toolCallId });
      enqueueChunk('9', {
        args,
        toolCallId,
        toolName: 'brainstrike.retrieveContext',
      });
      enqueueChunk('a', {
        isError: true,
        result: { error: options.errorMessage },
        toolCallId,
      });
      writeAssistantText(options.errorMessage);
      writeFinish('stop', { completionTokens: 8, promptTokens: 5 });
      return chunks;
    }
    default:
      writeAssistantText(options.message);
      writeFinish('stop', { completionTokens: 5, promptTokens: 10 });
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
    { apiKey: merged.apiKey, provider: merged.provider }
  );

  const installPayload: AssistantMockInstallPayload = {
    models: merged.models,
    provider: merged.provider,
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
