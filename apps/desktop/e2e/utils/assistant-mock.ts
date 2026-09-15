import {
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_MESSAGE_ID_HEADER,
} from '@brainstrike/assistant-contract/assistant-stream-session';
import type { SecretsWriteResult } from '@brainstrike/assistant-contract/secrets-bridge';
import { TOOL_SUSPEND_DATA_NAME } from '@brainstrike/assistant-contract/tool-suspend';
import type { Page } from '@playwright/test';

/** Replaced at serve time with the requesting leg's durable host run id. */
const HOST_RUN_ID_PLACEHOLDER = '__BRAINSTRIKE_HOST_RUN_ID__';

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-3.5-flash',
  openai: 'gpt-5.4',
  openrouter: 'openai/gpt-5.4',
} as const;

export interface AssistantMockOptions {
  readonly apiKey?: string;
  /** `provider::model` selected via the desktop test hooks after install. */
  readonly compositeModelKey?: string;
  readonly errorMessage?: string;
  readonly message?: string;
  readonly models?: Record<string, string>;
  readonly provider?: string;
  readonly variant?:
    | 'simple'
    | 'detailed'
    | 'tool'
    | 'tool-error'
    | 'stream-error'
    | 'network-suspend';
}

export interface AssistantProviderOptions {
  readonly apiKey?: string;
  readonly compositeModelKey?: string;
  readonly provider?: string;
}

interface AssistantMockInstallPayload {
  readonly assistantMessageId: string;
  /** Page-injected code carries no module scope: the placeholder travels here. */
  readonly hostRunIdPlaceholder: string;
  readonly models: Record<string, string>;
  readonly provider: string;
  readonly resumeStreamChunks?: Array<{ delayMs: number; payload: string }>;
  readonly streamChunks: Array<{ delayMs: number; payload: string }>;
  readonly streamEventIdHeaderName: string;
  readonly streamMessageIdHeaderName: string;
}

function installAssistantMockInPage(payload: AssistantMockInstallPayload): void {
  const globals = globalThis as unknown as Window & {
    __assistantMockApplied?: boolean;
    __assistantMockConfig?: AssistantMockInstallPayload;
    __assistantMockRequests?: unknown[];
    fetch: typeof fetch;
  };

  globals.__assistantMockConfig = payload;

  if (globals.__assistantMockApplied) {
    return;
  }

  globals.__assistantMockApplied = true;

  const encoder = new TextEncoder();
  const originalFetch = globals.fetch.bind(globals);

  function createMockResponse(
    signal: AbortSignal | undefined,
    configuredChunks?: Array<{ delayMs: number; payload: string }>,
    hostRunId?: string
  ): Response {
    const activeConfig = globals.__assistantMockConfig;
    if (!activeConfig) {
      throw new Error('Assistant mock config is unavailable.');
    }

    const streamChunks = (configuredChunks ?? activeConfig.streamChunks).map((chunk) => {
      if (!chunk.payload.includes(payload.hostRunIdPlaceholder)) {
        return { ...chunk };
      }
      if (!hostRunId) {
        throw new Error('Assistant mock cannot stamp a pause: the request named no host run.');
      }
      return {
        ...chunk,
        payload: chunk.payload.split(payload.hostRunIdPlaceholder).join(hostRunId),
      };
    });
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
        [payload.streamEventIdHeaderName]: `e2e-session-${Date.now()}:-1`,
        [payload.streamMessageIdHeaderName]: payload.assistantMessageId,
        'x-vercel-ai-data-stream': 'v1',
      },
      status: 200,
    });
  }

  // Record the outgoing request body so specs can assert the effective run
  // configuration the app actually sends (e.g. BST-1170's reasoning-aware
  // output window). A malformed body fails the fetch — and therefore the
  // spec — visibly.
  async function recordAssistantRequestBody(
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1]
  ): Promise<unknown> {
    const rawBody =
      typeof init?.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : undefined;
    if (!rawBody) {
      return;
    }
    const body: unknown = JSON.parse(rawBody);
    globals.__assistantMockRequests = globals.__assistantMockRequests ?? [];
    globals.__assistantMockRequests.push(body);
    return body;
  }

  /**
   * The DURABLE host leg of THIS request (`data.memory.runId`, minted by
   * `prepareRequestData` -> `createThreadRun` before the POST). The real host
   * stamps it on every pause it streams; a mock that served a fixed id would
   * hand the history topology adapter a leg that never existed.
   */
  function readRequestHostRunId(body: unknown): string | undefined {
    const data = (body as { data?: { memory?: { runId?: unknown } } } | undefined)?.data;
    const runId = data?.memory?.runId;
    return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
  }

  function selectConfiguredStreamChunks(): Array<{ delayMs: number; payload: string }> | undefined {
    const activeConfig = globals.__assistantMockConfig;
    const requestCount = globals.__assistantMockRequests?.length ?? 0;
    if (requestCount > 1 && activeConfig?.resumeStreamChunks) {
      return activeConfig.resumeStreamChunks;
    }
    return activeConfig?.streamChunks;
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
      const body = await recordAssistantRequestBody(input, init);
      return createMockResponse(
        init?.signal ?? undefined,
        selectConfiguredStreamChunks(),
        readRequestHostRunId(body)
      );
    }

    return originalFetch(input, init);
  };
}

const defaultOptions: Required<AssistantMockOptions> = {
  apiKey: 'test-api-key-for-e2e-tests',
  compositeModelKey: 'openai::gpt-5.2',
  errorMessage: 'Assistant request failed.',
  message: 'Hello from desktop assistant!',
  models: DEFAULT_MODELS,
  provider: 'openai',
  variant: 'simple',
};

interface AssistantProviderInstallPayload {
  readonly apiKey: string;
  readonly compositeModelKey: string;
  readonly ignoreStorageErrors: boolean;
  readonly models: Record<string, string>;
  readonly provider: string;
}

function configureAssistantProviderInPage(payload: AssistantProviderInstallPayload): void {
  const assistantAvailabilityOverrideEvent = 'brainstrike:assistant-availability-override-changed';
  const globals = globalThis as unknown as Window & {
    __assistantAvailabilityOverride?: { state: 'enabled' };
    __brainstrikeAssistantRuntimeTestHooks__?: {
      setCurrentThreadModel: (compositeKey: string) => void;
    };
    __brainstrikeTestHooks__?: {
      notifySecretsChanged: () => void;
      setAssistantModel: (compositeKey: string) => void;
    };
    localStorage?: Storage;
  };
  // Scoped separately from the Window cast: this page-injected configuration
  // feeds a deliberately simplified string[] `list` result, which must not
  // intersect with the real SecretsBridge typing on Window['secrets'].
  const secretsGlobals = globalThis as unknown as {
    secrets?: {
      list?: () => Promise<string[]>;
      [key: string]: unknown;
    };
  };

  try {
    globals.localStorage?.setItem(
      'assistant-preferences.v1',
      JSON.stringify({
        state: {
          modelsByProvider: payload.models,
          selectedProvider: payload.provider,
        },
        version: 1,
      })
    );
  } catch (error) {
    if (!payload.ignoreStorageErrors) {
      throw error;
    }
    // Preserve setupAssistantMock's existing tolerance for constrained storage.
  }
  globals.__assistantAvailabilityOverride = { state: 'enabled' };
  globals.dispatchEvent(new Event(assistantAvailabilityOverrideEvent));
  secretsGlobals.secrets = {
    ...secretsGlobals.secrets,
    list: async () => [payload.provider],
  };

  const hooks = globals.__brainstrikeTestHooks__;
  if (!hooks) {
    throw new Error('Brainstrike desktop test hooks are unavailable.');
  }
  hooks.notifySecretsChanged();
  hooks.setAssistantModel(payload.compositeModelKey);
  globals.__brainstrikeAssistantRuntimeTestHooks__?.setCurrentThreadModel(
    payload.compositeModelKey
  );
}

async function configureAssistantProviderWithModels(
  page: Page,
  payload: AssistantProviderInstallPayload
): Promise<void> {
  // Electron 43's V8 inspector weakly owns awaited evaluation results. Keep
  // the actual write reachable through a remote object until it settles;
  // retaining only an async wrapper does not retain its awaited promise.
  const pendingWrite = await page.evaluateHandle(
    ({ apiKey, provider }) => {
      const secrets = (
        globalThis as unknown as {
          secrets?: { saveKey?: (provider: string, key: string) => Promise<SecretsWriteResult> };
        }
      ).secrets;
      if (typeof secrets?.saveKey !== 'function') {
        throw new Error('Desktop secrets.saveKey is unavailable.');
      }
      const write = secrets.saveKey(provider, apiKey);
      // Observe rejection in the same turn as invocation. Waiting until the
      // next CDP command would briefly leave an immediate rejection unhandled.
      const completion = write.then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ error, ok: false }) as const
      );
      // A derived completion promise alone does not keep its source alive.
      return { completion, write };
    },
    { apiKey: payload.apiKey, provider: payload.provider }
  );
  try {
    await pendingWrite.evaluate(async ({ completion }) => {
      const result = await completion;
      if (!result.ok) {
        throw result.error;
      }
      if (result.value !== true) {
        throw new Error(`Assistant provider key save failed: ${result.value.error}`);
      }
    });
  } finally {
    await pendingWrite.dispose();
  }
  await page.evaluate(configureAssistantProviderInPage, payload);
}

/**
 * Configures the real assistant provider/key/model seams without replacing
 * the app's internal `/assistant` endpoint. Use this when an E2E needs the
 * real server-side Mastra loop and native-tool execution.
 */
export async function configureAssistantProvider(
  page: Page,
  options: AssistantProviderOptions = {}
): Promise<void> {
  const provider = options.provider ?? defaultOptions.provider;
  const defaultModel = DEFAULT_MODELS[provider];
  const compositeModelKey =
    options.compositeModelKey ??
    (provider === defaultOptions.provider
      ? defaultOptions.compositeModelKey
      : defaultModel
        ? `${provider}::${defaultModel}`
        : undefined);
  if (!compositeModelKey) {
    throw new Error(`No default assistant model is configured for provider "${provider}".`);
  }
  await configureAssistantProviderWithModels(page, {
    apiKey: options.apiKey ?? defaultOptions.apiKey,
    compositeModelKey,
    ignoreStorageErrors: false,
    models: DEFAULT_MODELS,
    provider,
  });
}

function buildAssistantStreamChunks(
  options: Required<AssistantMockOptions>,
  assistantMessageId: string
): Array<{
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

  enqueueChunk('f', { messageId: assistantMessageId, path: [] });

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
    case 'network-suspend':
      enqueueChunk('aui-data', {
        data: {
          // Substituted per request with that leg's durable host run id, the
          // way the desktop host stamps a live pause.
          hostRunId: HOST_RUN_ID_PLACEHOLDER,
          runId: 'run-network-e2e',
          suspendPayload: {
            allowedDomains: ['pypi.org', '*.githubusercontent.com'],
            kind: 'network',
          },
          toolCallId: 'call-network-e2e',
          toolName: 'brainstrike.runPython',
        },
        name: TOOL_SUSPEND_DATA_NAME,
      });
      writeFinish('stop', { completionTokens: 0, promptTokens: 5 });
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

function buildResumeStreamChunks(assistantMessageId: string): Array<{
  delayMs: number;
  payload: string;
}> {
  const encode = (code: string, value: unknown): string => `${code}:${JSON.stringify(value)}\n`;
  const usage = { inputTokens: 5, outputTokens: 2 };
  return [
    { delayMs: 0, payload: encode('f', { messageId: assistantMessageId, path: [] }) },
    { delayMs: 0, payload: encode('0', 'Network decision resumed.') },
    {
      delayMs: 0,
      payload: encode('e', { finishReason: 'stop', isContinued: false, usage }),
    },
    { delayMs: 0, payload: encode('d', { finishReason: 'stop', path: [], usage }) },
  ];
}

export async function setupAssistantMock(
  page: Page,
  options?: AssistantMockOptions
): Promise<void> {
  const merged = { ...defaultOptions, ...options };
  const assistantMessageId = `msg-${Date.now()}`;

  await configureAssistantProviderWithModels(page, {
    apiKey: merged.apiKey,
    compositeModelKey: merged.compositeModelKey,
    ignoreStorageErrors: true,
    models: merged.models,
    provider: merged.provider,
  });

  const installPayload: AssistantMockInstallPayload = {
    assistantMessageId,
    hostRunIdPlaceholder: HOST_RUN_ID_PLACEHOLDER,
    models: merged.models,
    provider: merged.provider,
    ...(merged.variant === 'network-suspend'
      ? { resumeStreamChunks: buildResumeStreamChunks(`${assistantMessageId}-resume`) }
      : {}),
    streamChunks: buildAssistantStreamChunks(merged, assistantMessageId),
    streamEventIdHeaderName: ASSISTANT_STREAM_EVENT_ID_HEADER,
    streamMessageIdHeaderName: ASSISTANT_STREAM_MESSAGE_ID_HEADER,
  };

  await page.evaluate(installAssistantMockInPage, installPayload);
}

/**
 * Request bodies the app POSTed to the mocked assistant endpoint, in order.
 * Parsed JSON — specs assert on the effective run configuration
 * (`data.modelSettings`, `data.providerOptions`, …).
 */
export async function readAssistantMockRequests(page: Page): Promise<unknown[]> {
  return await page.evaluate(
    () => (globalThis as { __assistantMockRequests?: unknown[] }).__assistantMockRequests ?? []
  );
}

export interface SeededCompactionSummaryThread {
  readonly summaryText: string;
  readonly threadId: string;
  readonly title: string;
}

/**
 * Seeds the real durable message shape used by conversation compaction.
 *
 * The desktop mock uses the legacy data-stream protocol, whose annotation
 * channel cannot populate assistant-ui's `metadata.custom`. Seeding format-2
 * history is therefore the fixed-fixture equivalent for this marker and also
 * exercises the production hydration seam that preserves it.
 */
export async function seedCompactionSummaryThread(
  page: Page
): Promise<SeededCompactionSummaryThread> {
  const title = `Compaction E2E ${Date.now()}`;
  const summaryText = [
    'Goal',
    'Keep the compaction divider visible.',
    '',
    'State',
    'The earlier discussion has been condensed.',
    '',
    'Decisions',
    'Render durable summary content as a system card.',
    '',
    'Next',
    'Continue the same thread normally.',
    '',
    'Files touched',
    'None.',
  ].join('\n');

  const threadId = await page.evaluate(
    async ({ summaryText: text, title: threadTitle }) => {
      const api = (window as Window & { electronAPI?: unknown }).electronAPI;
      const query = (
        api as {
          db?: {
            query?: (
              sql: string,
              params?: readonly unknown[]
            ) => Promise<{ rows?: readonly Record<string, unknown>[] }>;
          };
        }
      )?.db?.query;
      if (typeof query !== 'function') {
        throw new Error('Electron db.query bridge is not available');
      }

      const resourceResult = await query(
        `SELECT "resourceId"
           FROM mastra_threads
          ORDER BY "createdAt" DESC
          LIMIT 1`
      );
      const resourceId = resourceResult.rows?.[0]?.['resourceId'];
      if (typeof resourceId !== 'string' || resourceId.trim().length === 0) {
        throw new Error('A seeded assistant resource is required before compaction history setup.');
      }

      const seededThreadId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const content = {
        format: 2,
        metadata: {
          custom: {
            brainstrikeCompactionSummary: {
              createdAt,
              fallbackKind: 'agentic',
              firstCompactedMessageId: 'e2e-compacted-first',
              lastCompactedMessageId: 'e2e-compacted-last',
              rewriteId: crypto.randomUUID(),
            },
          },
        },
        parts: [{ text, type: 'text' }],
      };

      await query(
        `INSERT INTO mastra_threads
           (id, "resourceId", title, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
        [seededThreadId, resourceId, threadTitle, '{}', createdAt]
      );
      await query(
        `INSERT INTO mastra_messages
           (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ($1, $2, $3::jsonb, 'assistant', 'v2', $4, $5)`,
        [messageId, seededThreadId, JSON.stringify(content), createdAt, resourceId]
      );

      return seededThreadId;
    },
    { summaryText, title }
  );

  return { summaryText, threadId, title };
}
