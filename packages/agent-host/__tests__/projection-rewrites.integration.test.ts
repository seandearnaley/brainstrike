import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeyAuthInput, type RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import { storedHostEvent } from '../src/event-storage.js';
import type { HostPlatform, HostProjectionRewriteRequest, HostTool } from '../src/ports.js';
import { createProductionHostPlatform } from '../src/production-platform.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';

const candidate = join(import.meta.dirname, '../../..');
const provider = 'openai';
const modelId = 'gpt-6-sol';
const MARKER = '[pruned old tool result — tool=brainstrike.grepSearch args=fixture]';

afterEach(() => vi.unstubAllGlobals());

/** A committed earlier turn whose one step called grep and got `result` back. */
function grepTurn(threadId: string, index: number, result: string): HostEvent[] {
  const runId = randomUUID();
  const commandId = randomUUID();
  const prompt = `Search ${index}`;
  const toolCallId = `call-grep-${index}`;
  return [
    {
      commandId,
      method: 'run/start',
      payload: { commandId, modelId, prompt, threadId },
      result: { runId },
      type: 'command.accepted',
    },
    {
      modelId,
      prompt,
      runId,
      snapshot: { configuration: { model: modelId, provider }, maxSteps: 2, toolIdentities: {} },
      type: 'run.started',
    },
    {
      messages: [
        {
          content: [
            {
              input: { pattern: `needle-${index}` },
              toolCallId,
              toolName: 'brainstrike_grepSearch',
              type: 'tool-call',
            },
          ],
          role: 'assistant',
        },
        {
          content: [
            {
              output: { type: 'text', value: result },
              toolCallId,
              toolName: 'brainstrike_grepSearch',
              type: 'tool-result',
            },
          ],
          role: 'tool',
        },
      ],
      model: { modelId, provider: 'openai.responses' },
      runId,
      stepNumber: 0,
      type: 'model.step',
      usage: { inputTokens: 11, outputTokens: 12, totalTokens: 23 },
    },
    {
      messages: [{ content: [{ text: `found ${index}`, type: 'text' }], role: 'assistant' }],
      model: { modelId, provider: 'openai.responses' },
      runId,
      stepNumber: 1,
      type: 'model.step',
      usage: { inputTokens: 11, outputTokens: 12, totalTokens: 23 },
    },
    { outcome: 'completed', runId, type: 'run.finished' },
  ];
}

async function grepThreadHost(
  results: readonly string[],
  selectProjectionRewrites: HostPlatform['selectProjectionRewrites'],
  scripted?: {
    readonly maxSteps: number;
    readonly model: MockLanguageModelV4;
    readonly tools: Readonly<Record<string, HostTool>>;
  }
) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-projection-rewrites-'));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: join(
      candidate,
      'packages/agent-host/dist/adapters/memory-storage-calculator.js'
    ),
  });
  let core: HostCore | undefined;
  onTestFinished(async () => {
    await core?.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const threadId = randomUUID();
  for (const [index, result] of results.entries()) {
    await store.append(
      grepTurn(threadId, index, result).map((event) => storedHostEvent(threadId, event)),
      undefined,
      'full'
    );
  }
  const configuration: RuntimeData = { model: modelId, provider };
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async () => ({
      configuration,
      durableConfiguration: { model: modelId, provider },
      maxSteps: scripted?.maxSteps ?? 1,
      memory: {
        native: {
          options: {
            lastMessages: 200,
            observationalMemory: false,
            semanticRecall: false,
            workingMemory: { enabled: false },
          },
        },
        recordPrompt: async () => undefined,
        resourceId: 'm3-projection-rewrites-fixture',
      },
      providerRequestContext: { inputTokenLimit: 100_000, provider, runtimeData: configuration },
      resolvedToolResultBudget: resolveScaledToolResultBudget(100_000),
      tools: scripted?.tools ?? {},
      toolTimeoutMs: 1000,
    }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    ...(scripted ? { resolveModel: async () => scripted.model } : {}),
    resolveProviderAuth: async () => apiKeyAuthInput('offline-rewrite-fixture-key'),
    selectProjectionRewrites,
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  core = await HostCore.open(store, platform, () => () => undefined);
  const opened = core;
  return async (prompt: string) => {
    const finished = Promise.withResolvers<void>();
    const unsubscribe = opened.onCommitted((row) => {
      if (row.threadId === threadId && row.event.type === 'run.finished') {
        finished.resolve();
      }
    });
    try {
      await opened.startRun({ commandId: randomUUID(), modelId, prompt, threadId });
      await finished.promise;
      return (await opened.read(threadId, 0)).map((row) => row.event);
    } finally {
      unsubscribe();
    }
  };
}

test('a committed tool-output rewrite replaces that result in the next request, from the policy the platform supplies', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(await new Request(input, init).text());
      return Response.json(
        { error: { message: 'Offline rewrite fixture', type: 'fixture_terminal' } },
        { status: 400 }
      );
    })
  );
  const asked: HostProjectionRewriteRequest[] = [];
  const run = await grepThreadHost(
    ['old-grep-output '.repeat(50), 'new-grep-output'],
    (request) => {
      asked.push(request);
      return request.invocations
        .filter(({ toolCallId }) => toolCallId === 'call-grep-0')
        .map(({ toolCallId }) => ({
          kind: 'prune' as const,
          markerText: MARKER,
          supersededByToolCallId: null,
          toolCallId,
        }));
    }
  );
  const first = await run('Search again');

  // The policy saw every committed call on the branch, oldest first.
  expect(asked).toHaveLength(1);
  expect(asked[0]?.invocations.map((invocation) => invocation.toolCallId)).toEqual([
    'call-grep-0',
    'call-grep-1',
  ]);
  expect(asked[0]?.invocations[0]).toMatchObject({
    args: { pattern: 'needle-0' },
    modelOutput: { type: 'text', value: 'old-grep-output '.repeat(50) },
    toolName: 'brainstrike_grepSearch',
  });
  expect(asked[0]?.currentTurnToolCallIds.size).toBe(0);
  expect(first.filter((event) => event.type === 'tool.projection.rewritten')).toEqual([
    expect.objectContaining({
      rewrites: [
        {
          kind: 'prune',
          markerText: MARKER,
          supersededByToolCallId: null,
          toolCallId: 'call-grep-0',
        },
      ],
    }),
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain(MARKER);
  expect(requests[0]).not.toContain('old-grep-output');
  expect(requests[0]).toContain('new-grep-output');

  // A later run reapplies the committed rewrite and never offers that call again.
  await run('One more');
  expect(asked[1]?.invocations.map((invocation) => invocation.toolCallId)).toEqual(['call-grep-1']);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain(MARKER);
  expect(requests[1]).not.toContain('old-grep-output');
});

test('a stale read is superseded within the run once the run edits that file, using the raw committed output', async () => {
  const marker = 'read repo:src/a.ts lines 1-2000/2000 [superseded — file was modified]';
  const prompts: string[] = [];
  const source = scriptedToolSequence([{ input: { path: 'src/a.ts' }, toolId: 'edit' }]);
  const model = new MockLanguageModelV4({
    doStream: (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return source.doStream(options);
    },
    modelId,
    provider: 'openai.responses',
  });
  const edit: HostTool = {
    description: 'Recorded edit tool',
    execute: async () => ({ path: 'src/a.ts', rootName: 'repo' }),
    identity: 'edit-fixture-binding',
    inputSchema: z.object({ path: z.string() }),
    risk: 'read',
  };
  const asked: HostProjectionRewriteRequest[] = [];
  const run = await grepThreadHost(
    ['stale-read-body '.repeat(50)],
    (request) => {
      asked.push(request);
      const write = request.invocations.find((invocation) => invocation.toolName === 'edit');
      return write
        ? [
            {
              kind: 'supersession' as const,
              markerText: marker,
              supersededByToolCallId: write.toolCallId,
              toolCallId: 'call-grep-0',
            },
          ]
        : [];
    },
    { maxSteps: 2, model, tools: { edit } }
  );
  const events = await run('Edit src/a.ts');

  expect(events.at(-1)).toMatchObject({ outcome: 'completed', type: 'run.finished' });
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain('stale-read-body');
  expect(prompts[1]).toContain(marker);
  expect(prompts[1]).not.toContain('stale-read-body');
  // The second step's policy request carries the run's own call and its raw output.
  expect(asked).toHaveLength(2);
  expect(asked[1]?.currentTurnToolCallIds).toEqual(new Set(['recorded-call-1']));
  expect(asked[1]?.invocations.at(-1)).toMatchObject({
    output: { path: 'src/a.ts', rootName: 'repo' },
    toolCallId: 'recorded-call-1',
    toolName: 'edit',
  });
  expect(events.filter((event) => event.type === 'tool.projection.rewritten')).toEqual([
    expect.objectContaining({
      rewrites: [
        {
          kind: 'supersession',
          markerText: marker,
          supersededByToolCallId: 'recorded-call-1',
          toolCallId: 'call-grep-0',
        },
      ],
    }),
  ]);
});
