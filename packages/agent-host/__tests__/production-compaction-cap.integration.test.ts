/**
 * BST-2539: the production admission compacts a thread at the cap its run was
 * configured with (the person's setting, on desktop), and at the 200,000-token
 * default when the configuration carries none, on a 1M window's budget.
 */
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import {
  DEFAULT_PERMISSION_POLICIES,
  deriveEffectiveInputBudget,
} from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostPlatform } from '../src/ports.ts';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../src/production-platform.ts';
import type { HostEvent } from '../src/protocol.ts';
import {
  type Chunk,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
} from './fixtures/child-run-host.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** A 1M window's budget: 945,904 tokens, 90% of it far past either cap. */
const BUDGET = deriveEffectiveInputBudget(1_000_000);
const SUMMARY = 'Goal: g\nConstraints: c\nDecisions: d\nErrors and fixes: none\nState: s\nNext: n';

function usage(inputTokens: number) {
  return {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: inputTokens, total: inputTokens },
    outputTokens: { reasoning: 0, text: 1, total: 1 },
  };
}

function answer(inputTokens: number): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { id: 'text-1', type: 'text-start' },
    { delta: 'Answered.', id: 'text-1', type: 'text-delta' },
    { id: 'text-1', type: 'text-end' },
    { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage: usage(inputTokens) },
  ];
}

/** A host whose runs pass the production admission, configured with `compactionTokenCap`. */
async function productionHost(compactionTokenCap: number | undefined) {
  let reported = 1000;
  const model = new MockLanguageModelV4({
    // The compaction summarizer's side call.
    doGenerate: async () => ({
      content: [{ text: SUMMARY, type: 'text' }],
      finishReason: { raw: 'stop', unified: 'stop' },
      usage: usage(400),
      warnings: [],
    }),
    doStream: async () => stream(answer(reported)),
  });
  let production: HostPlatform | undefined;
  const harness = await setupChildRunHost(model, cleanup, {}, () => async (request) => {
    if (!production?.admitRun) {
      throw new Error('The production platform is not composed');
    }
    return await production.admitRun(request);
  });
  const configuration = { model: 'scripted', provider: 'scripted' };
  const selected: ProductionHostRunConfiguration = {
    ...(compactionTokenCap === undefined ? {} : { compactionTokenCap }),
    configuration,
    durableConfiguration: {},
    maxSteps: 4,
    providerRequestContext: {
      inputTokenLimit: BUDGET,
      provider: 'openai',
      runtimeData: configuration,
    },
    resolvedToolResultBudget: resolveScaledToolResultBudget(1_000_000),
    resolveProviderAuth: async () => undefined,
    tools: {},
    toolTimeoutMs: 60_000,
  };
  production = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async () => selected,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => model,
    resolveProviderAuth: async () => undefined,
    startup: {
      register: async (close) => {
        cleanup.push(close);
      },
      signal: new AbortController().signal,
      store: harness.store,
    },
  });
  const ask = async (prompt: string) => {
    const runId = await harness.start(prompt);
    const rows = await rowsUntil(harness, harness.threadId, finished(runId), 15_000);
    return { compactions: rows.flatMap(compaction), runId };
  };
  /** The thread's third request is reported at `inputTokens`; the fourth run's compactions. */
  const fourthAfterReporting = async (inputTokens: number) => {
    // Two questions of 25,000 estimated tokens, then a short one: the protect
    // window keeps the newest three turns, so only the first can be compacted.
    const first = await ask(`First ${'a'.repeat(100_000)}`);
    await ask(`Second ${'b'.repeat(100_000)}`);
    reported = inputTokens;
    await ask('Third question.');
    const fourth = await ask('Fourth question.');
    return { compactions: fourth.compactions, first: first.runId };
  };
  return { fourthAfterReporting };
}

function compaction(row: { readonly event: HostEvent }) {
  return row.event.type === 'context.compacted' ? [row.event] : [];
}

test('a run admitted with the compaction cap at 100,000 compacts its thread past 100,000 tokens', async () => {
  const host = await productionHost(100_000);
  const { compactions, first } = await host.fourthAfterReporting(110_000);
  expect(compactions).toMatchObject([
    { compactedRunIds: [first], reason: 'pre-request', summary: SUMMARY },
  ]);
});

test('a run admitted with no compaction cap compacts at the 200,000-token default', async () => {
  const under = await (await productionHost(undefined)).fourthAfterReporting(110_000);
  expect(under.compactions).toEqual([]);
  const past = await (await productionHost(undefined)).fourthAfterReporting(210_000);
  expect(past.compactions).toMatchObject([
    { compactedRunIds: [past.first], reason: 'pre-request' },
  ]);
});
