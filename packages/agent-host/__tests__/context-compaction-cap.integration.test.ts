/**
 * BST-2526: a thread compacts by its provider's own count of its request, at
 * the run's 200K cap, though the model's budget is far larger and the chars/4
 * estimate of its branch is far smaller. With no count reported, the run's
 * instructions count toward the estimate.
 */
import {
  CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP,
  deriveEffectiveInputBudget,
} from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostRunAdmission } from '../src/ports.ts';
import type { HostEvent } from '../src/protocol.ts';
import {
  type Chunk,
  finished,
  recordingAdmission,
  rowsUntil,
  setupChildRunHost,
  stream,
  userTexts,
} from './fixtures/child-run-host.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** The provider's usage; `inputTokens` undefined is a provider that reports none. */
function usage(inputTokens: number | undefined) {
  return {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: inputTokens, total: inputTokens },
    outputTokens: { reasoning: 0, text: 1, total: 1 },
  };
}

/** An answer whose provider reported `inputTokens` for the request it answered. */
function answer(inputTokens: number | undefined): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { id: 'text-1', type: 'text-start' },
    { delta: 'Answered.', id: 'text-1', type: 'text-delta' },
    { id: 'text-1', type: 'text-end' },
    { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage: usage(inputTokens) },
  ];
}

const SUMMARY = 'Goal: g\nState: s\nDecisions: d\nNext: n\nFiles touched: none';

/** A model whose answers report `reported()` input tokens; its side calls summarize. */
function reportingModel(reported: () => number | undefined): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    // The compaction summarizer's side call.
    doGenerate: async () => ({
      content: [{ text: SUMMARY, type: 'text' }],
      finishReason: { raw: 'stop', unified: 'stop' },
      usage: usage(400),
      warnings: [],
    }),
    doStream: async () => stream(answer(reported())),
  });
}

/** A host whose admission carries `bounds` beside the fixture's own selection. */
async function hostAdmitting(
  model: MockLanguageModelV4,
  bounds: (admission: HostRunAdmission) => Partial<HostRunAdmission>
) {
  const harness = await setupChildRunHost(model, cleanup, {}, (platform) => async (request) => {
    const admitted = await recordingAdmission([])(platform)?.(request);
    if (!admitted) {
      throw new Error('The fixture admission admitted nothing');
    }
    return { ...admitted, ...bounds(admitted) };
  });
  const ask = async (prompt: string) => {
    const runId = await harness.start(prompt);
    const rows = await rowsUntil(harness, harness.threadId, finished(runId), 15_000);
    return { compactions: rows.flatMap(compaction), runId };
  };
  return { ask };
}

function compaction(row: { readonly event: HostEvent }) {
  return row.event.type === 'context.compacted' ? [row.event] : [];
}

test('a thread whose provider reported its request past the cap compacts before its next run', async () => {
  let reported = 1000;
  const model = reportingModel(() => reported);
  const host = await hostAdmitting(model, () => ({
    compactionTokenCap: CONTEXT_COMPACTION_DEFAULT_TOKEN_CAP,
    // A 1M window's budget: 90% of it (851,314) is far past the cap.
    inputTokenLimit: deriveEffectiveInputBudget(1_000_000),
  }));
  // Two questions of 25,000 estimated tokens, then a short one: the protect
  // window keeps the newest three turns, so only the first can be compacted.
  const first = await host.ask(`First ${'a'.repeat(100_000)}`);
  await host.ask(`Second ${'b'.repeat(100_000)}`);
  // The third request's provider reports 210,000 input tokens.
  reported = 210_000;
  await host.ask('Third question.');
  const fourth = await host.ask('Fourth question.');

  expect(fourth.compactions).toMatchObject([
    {
      compactedRunIds: [first.runId],
      kind: 'agentic',
      reason: 'pre-request',
      runId: fourth.runId,
      summary: SUMMARY,
    },
  ]);
  const request = model.doStreamCalls.at(-1);
  expect(request && userTexts(request).some((text) => text.startsWith('First'))).toBe(false);
});

test('with no count reported, the run’s instructions count toward when its thread compacts', async () => {
  const compactedBy = async (instructions: string | undefined) => {
    const model = reportingModel(() => undefined);
    const host = await hostAdmitting(model, (admitted) => ({
      // About 50,000 estimated tokens of branch against a 63,000-token trigger.
      inputTokenLimit: 70_000,
      provider: {
        prepare: async (request) => ({
          messages: [...request.messages],
          model: admitted.model,
          ...(instructions === undefined ? {} : { system: instructions }),
        }),
      },
    }));
    const first = await host.ask(`First ${'a'.repeat(100_000)}`);
    await host.ask(`Second ${'b'.repeat(100_000)}`);
    const third = await host.ask('Third question.');
    return { compactions: third.compactions, first: first.runId, third: third.runId };
  };
  expect((await compactedBy(undefined)).compactions).toEqual([]);
  // 15,000 tokens of instructions take the request past the trigger.
  const instructed = await compactedBy('i'.repeat(60_000));
  expect(instructed.compactions).toMatchObject([
    { compactedRunIds: [instructed.first], reason: 'pre-request', runId: instructed.third },
  ]);
});
