import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKeyAuthInput, type RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { wrapLanguageModel } from 'ai';
import { afterEach, expect, test, vi } from 'vitest';
import { HostCore } from '../src/core.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../src/production-platform.js';
import type { HostEvent, HostLogRow } from '../src/protocol.js';
import { HOST_THREAD_TITLE_INSTRUCTIONS } from '../src/thread-presentation-state.js';
import { foldHostRuns } from '../src/thread-view.js';
import {
  anthropicMessageJson,
  anthropicMessagesText,
  openAIResponsesJson,
  openAIResponsesText,
} from './fixtures/provider-responses.js';

type Provider = 'openai' | 'anthropic';
type Finished = Extract<HostEvent, { type: 'run.finished' }>;
interface SdkError {
  readonly message: string;
  readonly name: string;
  readonly statusCode: number;
}

const cases = (['openai', 'anthropic'] as const).flatMap((provider) =>
  (['nonempty', 'empty', 'malformed-empty-status'] as const).map(
    (messageCase) => [provider, messageCase] as const
  )
);

afterEach(() => vi.unstubAllGlobals());

// The machine runs many suites at once; a run's terminal commit can take seconds.
const TERMINAL_POLL = { interval: 50, timeout: 30_000 };

/**
 * Run one production-platform host turn whose provider HTTP exchange is
 * answered offline: the run's own requests by `respond` (call number from 1),
 * and a thread title request, identified by its instructions, with a title.
 * No native network fetch or environment credential is read.
 */
async function runAgainstProviderHttp(
  provider: Provider,
  respond: (call: number) => Response,
  options: { readonly awaitTitle?: boolean } = {}
): Promise<{
  readonly fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  readonly rows: readonly HostLogRow[];
  readonly runRequests: number;
  readonly sdkErrors: readonly SdkError[];
  readonly terminal: Finished;
  readonly titleRequests: number;
}> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-provider-http-error-'));
  const modelId = provider === 'openai' ? 'gpt-4.1-mini-2025-04-14' : 'claude-haiku-4-5-20251001';
  const configuration: RuntimeData = {
    model: modelId,
    modelSettings: { maxOutputTokens: 256 },
    provider,
  };
  let calls = 0;
  let titleRequests = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url =
      typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url);
    expect(url.href).toBe(
      provider === 'openai'
        ? 'https://api.openai.com/v1/responses'
        : 'https://api.anthropic.com/v1/messages'
    );
    expect(init?.method).toBe('POST');
    if (typeof init?.body === 'string' && init.body.includes(HOST_THREAD_TITLE_INSTRUCTIONS)) {
      titleRequests += 1;
      const title = provider === 'openai' ? openAIResponsesJson : anthropicMessageJson;
      return title('offline-model', 'Offline title');
    }
    calls += 1;
    return respond(calls);
  });
  vi.stubGlobal('fetch', fetch);
  const sdkErrors: SdkError[] = [];
  const store = await StateStore.open(root, {
    memoryCalculatorModule: fileURLToPath(
      new URL('../dist/adapters/memory-storage-calculator.js', import.meta.url)
    ),
  });
  let core: HostCore | undefined;
  try {
    const platform = await createProductionHostPlatform({
      close: async () => undefined,
      readConfiguration: async (): Promise<ProductionHostRunConfiguration> => ({
        configuration,
        durableConfiguration: { model: modelId, modelSettings: { maxOutputTokens: 256 }, provider },
        maxSteps: 1,
        memory: {
          native: {
            options: {
              observationalMemory: false,
              semanticRecall: false,
              workingMemory: { enabled: false },
            },
          },
          recordPrompt: async () => undefined,
          resourceId: 'm3-provider-http-error-fixture',
        },
        providerRequestContext: { inputTokenLimit: 5000, provider, runtimeData: configuration },
        resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
        tools: {},
        toolTimeoutMs: 1000,
      }),
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveProviderAuth: async () => apiKeyAuthInput('offline-fixture-key'),
      startup: {
        register: async () => undefined,
        signal: new AbortController().signal,
        store,
      },
    });
    const admitRun = platform.admitRun;
    if (!admitRun) {
      throw new Error('Production host admission is unavailable');
    }
    platform.admitRun = async (request) => {
      const selected = await admitRun.call(platform, request);
      const openRun = selected.openRun;
      if (!openRun) {
        throw new Error('Production host Memory owner is unavailable');
      }
      return {
        ...selected,
        openRun: async (context) => {
          const owner = await openRun.call(selected, context);
          return {
            close: () => owner.close(),
            commitHostStep: () => owner.commitHostStep?.() ?? Promise.resolve(),
            prepareHostModel: (model) => {
              const prepared = owner.prepareHostModel?.(model) ?? model;
              if (typeof prepared === 'string') {
                throw new Error('Production provider model must be concrete');
              }
              return wrapLanguageModel({
                middleware: {
                  specificationVersion: 'v4',
                  wrapStream: async ({ doStream }) => {
                    try {
                      return await doStream();
                    } catch (cause) {
                      if (
                        cause instanceof Error &&
                        'statusCode' in cause &&
                        typeof cause.statusCode === 'number'
                      ) {
                        sdkErrors.push({
                          message: cause.message,
                          name: cause.name,
                          statusCode: cause.statusCode,
                        });
                      }
                      // The public observer rethrows the identical error. Core
                      // and canonical provider preparation retain their behavior.
                      throw cause;
                    }
                  },
                },
                model: prepared,
              });
            },
            prepareHostStep: (request) =>
              owner.prepareHostStep?.(request) ??
              Promise.resolve({ messages: [...request.messages] }),
          };
        },
      };
    };
    core = await HostCore.open(store, platform, () => () => undefined);
    const opened = core;
    const { threadId } = await opened.startThread({ commandId: randomUUID() });
    const { runId } = await opened.startRun({
      commandId: randomUUID(),
      modelId,
      prompt: 'Synthetic offline HTTP failure test. No external action is authorized.',
      threadId,
    });
    let terminal: Finished | undefined;
    await expect
      .poll(async () => {
        terminal = (await opened.read(threadId, 0))
          .map((row) => row.event)
          .find(
            (event): event is Finished => event.type === 'run.finished' && event.runId === runId
          );
        return terminal !== undefined;
      }, TERMINAL_POLL)
      .toBe(true);
    if (!terminal) {
      throw new Error('Run did not finish');
    }
    if (options.awaitTitle) {
      await expect
        .poll(
          async () =>
            (await opened.read(threadId, 0)).some(
              (row) => row.event.type === 'thread.updated' && row.event.title !== undefined
            ),
          TERMINAL_POLL
        )
        .toBe(true);
    }
    return {
      fetch,
      rows: await opened.read(threadId, 0),
      runRequests: calls,
      sdkErrors,
      terminal,
      titleRequests,
    };
  } finally {
    await core?.close();
    await store.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { force: true, recursive: true });
  }
}

function errorChunks(rows: readonly HostLogRow[]): unknown[] {
  return rows.flatMap((row) => (row.event.type === 'stream.chunk' ? [row.event.chunk] : []));
}

test.each(cases)('%s HTTP 400 (%s) commits a failed run', async (provider, messageCase) => {
  const message = messageCase === 'nonempty' ? 'Synthetic provider request rejected.' : '';
  // Recorded SDK 7 HTTP 400 boundary from M3 qualification. These variants
  // isolate error-message presence from HTTP failure, including malformed envelopes.
  const envelope =
    messageCase === 'malformed-empty-status'
      ? {}
      : provider === 'anthropic'
        ? { error: { message, type: 'invalid_request_error' }, type: 'error' }
        : { error: { code: 'fixture_error', message, param: null, type: 'invalid_request_error' } };
  const { rows, runRequests, sdkErrors, terminal, titleRequests } = await runAgainstProviderHttp(
    provider,
    () =>
      new Response(JSON.stringify(envelope), {
        headers: { 'content-type': 'application/json', 'request-id': 'offline-request-id' },
        status: 400,
        statusText: messageCase === 'malformed-empty-status' ? '' : 'Bad Request',
      })
  );
  expect(runRequests).toBe(1);
  expect(sdkErrors).toEqual([{ message, name: 'AI_APICallError', statusCode: 400 }]);
  expect(errorChunks(rows)).toContainEqual(
    expect.objectContaining({
      error: expect.objectContaining({ statusCode: 400 }),
      type: 'error',
    })
  );
  expect(rows.some((row) => row.event.type === 'model.step')).toBe(false);
  expect(rows.some((row) => row.event.type === 'effect.started')).toBe(false);
  expect(terminal.outcome).toBe('failed');
  // A failed run makes no thread title request.
  expect(titleRequests).toBe(0);
});

// The providers' documented rejected-key envelopes.
const rejectedKey = {
  anthropic: {
    body: { error: { message: 'invalid x-api-key', type: 'authentication_error' }, type: 'error' },
    displayName: 'Anthropic',
    providerMessage: 'invalid x-api-key',
  },
  openai: {
    body: {
      error: {
        code: 'invalid_api_key',
        message: 'Incorrect API key provided: offline-*****-key.',
        param: null,
        type: 'invalid_request_error',
      },
    },
    displayName: 'OpenAI',
    providerMessage: 'Incorrect API key provided: offline-*****-key.',
  },
} as const;

test.each(['openai', 'anthropic'] as const)(
  '%s HTTP 401 fails at once with the credential remedy first',
  async (provider) => {
    const expected = rejectedKey[provider];
    const { runRequests, terminal, titleRequests } = await runAgainstProviderHttp(
      provider,
      () =>
        new Response(JSON.stringify(expected.body), {
          headers: { 'content-type': 'application/json', 'request-id': 'offline-request-id' },
          status: 401,
          statusText: 'Unauthorized',
        })
    );
    // A rejected credential is not transient: exactly one request.
    expect(runRequests).toBe(1);
    expect(terminal.outcome).toBe('failed');
    expect(terminal.detail).toBe(
      `${expected.displayName} rejected the API key (HTTP 401) — it is invalid or was revoked. ` +
        'Update the key in Settings → Providers, or verify it in the provider dashboard. ' +
        `Provider response: ${expected.providerMessage}`
    );
    expect(titleRequests).toBe(0);
  }
);

function jsonError(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'request-id': 'offline-request-id', ...headers },
    status,
  });
}

function preparedReceipts(rows: readonly HostLogRow[]): number {
  return rows.filter((row) => row.event.type === 'provider.request.prepared').length;
}

/** The committed answer: `model.step` text, never text deltas (ADR-0011 amendment). */
function committedText(rows: readonly HostLogRow[]): string {
  return foldHostRuns(rows)
    .map((run) => run.text)
    .join('');
}

// The providers' documented transient envelopes. `retry-after: 0` keeps the
// SDK's own Retry-After handling in the path without a real wait.
const transient = [
  [
    'openai',
    429,
    {
      error: {
        code: 'rate_limit_exceeded',
        message: 'Rate limit reached for requests.',
        param: null,
        type: 'requests',
      },
    },
  ],
  ['anthropic', 529, { error: { message: 'Overloaded', type: 'overloaded_error' }, type: 'error' }],
  [
    'openai',
    503,
    { error: { code: null, message: 'Service unavailable.', param: null, type: 'server_error' } },
  ],
] as const;

test.each(transient)(
  '%s HTTP %d before the stream opens is retried and the run completes',
  async (provider, status, body) => {
    const success = provider === 'openai' ? openAIResponsesText : anthropicMessagesText;
    const { fetch, rows, runRequests, terminal, titleRequests } = await runAgainstProviderHttp(
      provider,
      (call) =>
        call === 1
          ? jsonError(status, body, { 'retry-after': '0' })
          : success('offline-model', 'Recovered answer.'),
      { awaitTitle: true }
    );
    expect(runRequests).toBe(2);
    // The completed run's thread title is its one other provider request.
    expect(titleRequests).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(terminal.outcome).toBe('completed');
    expect(committedText(rows)).toBe('Recovered answer.');
    // The failed request never reached the log; each attempt left its receipt.
    expect(errorChunks(rows)).not.toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(preparedReceipts(rows)).toBe(2);
  }
);

test('a provider that stays unavailable fails visibly after the bounded retries', async () => {
  const body = {
    error: { code: null, message: 'Service unavailable.', param: null, type: 'server_error' },
  };
  const { rows, runRequests, terminal, titleRequests } = await runAgainstProviderHttp(
    'openai',
    () => jsonError(503, body, { 'retry-after': '0' })
  );
  // One request plus the SDK's two retries.
  expect(runRequests).toBe(3);
  expect(preparedReceipts(rows)).toBe(3);
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toContain('Service unavailable.');
  expect(titleRequests).toBe(0);
});
