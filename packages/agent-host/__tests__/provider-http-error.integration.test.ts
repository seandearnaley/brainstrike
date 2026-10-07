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
import type { HostEvent } from '../src/protocol.js';

const cases = (['openai', 'anthropic'] as const).flatMap((provider) =>
  (['nonempty', 'empty', 'malformed-empty-status'] as const).map(
    (messageCase) => [provider, messageCase] as const
  )
);

afterEach(() => vi.unstubAllGlobals());

test.each(cases)('%s HTTP 400 (%s) commits a failed run', async (provider, messageCase) => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-provider-http-error-'));
  const modelId = provider === 'openai' ? 'gpt-4.1-mini-2025-04-14' : 'claude-haiku-4-5-20251001';
  const configuration: RuntimeData = {
    model: modelId,
    modelSettings: { maxOutputTokens: 256 },
    provider,
  };
  const message = messageCase === 'nonempty' ? 'Synthetic provider request rejected.' : '';
  // Recorded SDK 7 HTTP 400 boundary from M3 qualification. These variants
  // isolate error-message presence from HTTP failure, including malformed envelopes.
  const envelope =
    messageCase === 'malformed-empty-status'
      ? {}
      : provider === 'anthropic'
        ? { error: { message, type: 'invalid_request_error' }, type: 'error' }
        : { error: { code: 'fixture_error', message, param: null, type: 'invalid_request_error' } };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url =
      typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url);
    expect(url.href).toBe(
      provider === 'openai'
        ? 'https://api.openai.com/v1/responses'
        : 'https://api.anthropic.com/v1/messages'
    );
    expect(init?.method).toBe('POST');
    return new Response(JSON.stringify(envelope), {
      headers: { 'content-type': 'application/json', 'request-id': 'offline-request-id' },
      status: 400,
      statusText: messageCase === 'malformed-empty-status' ? '' : 'Bad Request',
    });
  });
  // No native network fetch or environment credential is read in these cases.
  vi.stubGlobal('fetch', fetch);
  const sdkErrors: {
    readonly message: string;
    readonly name: string;
    readonly statusCode: number;
  }[] = [];
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
    let terminal: Extract<HostEvent, { type: 'run.finished' }> | undefined;
    await expect
      .poll(async () => {
        terminal = (await opened.read(threadId, 0))
          .map((row) => row.event)
          .find(
            (event): event is Extract<HostEvent, { type: 'run.finished' }> =>
              event.type === 'run.finished' && event.runId === runId
          );
        return terminal !== undefined;
      })
      .toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sdkErrors).toEqual([{ message, name: 'AI_APICallError', statusCode: 400 }]);
    const rows = await opened.read(threadId, 0);
    const chunks = rows.flatMap((row) =>
      row.event.type === 'stream.chunk' ? [row.event.chunk] : []
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ statusCode: 400 }),
        type: 'error',
      })
    );
    expect(rows.some((row) => row.event.type === 'model.step')).toBe(false);
    expect(rows.some((row) => row.event.type === 'effect.started')).toBe(false);
    expect(terminal?.outcome).toBe('failed');
  } finally {
    await core?.close();
    await store.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { force: true, recursive: true });
  }
});
