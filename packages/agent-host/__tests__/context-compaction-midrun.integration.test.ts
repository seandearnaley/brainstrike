/**
 * BST-2531: a run that outgrows its budget part-way through summarizes its
 * older steps between two steps, with a compaction card on the run, and
 * carries on; a request the provider boundary still has to trim says so.
 */

import { randomUUID } from 'node:crypto';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  committedRunMessages,
  createHostToolDiscovery,
} from '../src/adapters/host-tool-discovery.ts';
import type { HostRunAdmission, HostTool } from '../src/ports.ts';
import type { HostEvent, HostLogRow } from '../src/protocol.ts';
import { hostProviderHistory } from '../src/run-history.ts';
import { type ScriptedTurn, scriptedTurns } from '../src/test-fixtures/scripted-model.ts';
import {
  type CallOptions,
  type ChildRunFixture,
  finished,
  recordingAdmission,
  rowsUntil,
  setupChildRunHost,
  userTexts,
} from './fixtures/child-run-host.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const SUMMARY = 'Goal: g\nState: s\nDecisions: d\nNext: n\nFiles touched: none';
const QUESTION = 'Read the notes twelve times.';
/** About 4,000 tokens a read, as its result reaches the model. */
const NOTES = 'n'.repeat(16_000);

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;

function compactions(rows: readonly HostLogRow[]): Compacted[] {
  return rows.flatMap((row) => (row.event.type === 'context.compacted' ? [row.event] : []));
}

/** The tool calls a request carried, by id. */
function callIds(call: CallOptions): string[] {
  return call.prompt.flatMap((message) =>
    message.role === 'assistant'
      ? message.content.flatMap((part) => (part.type === 'tool-call' ? [part.toolCallId] : []))
      : []
  );
}

type Call = ScriptedTurn['steps'][number][number];

/** `count` reads of the notes, one a step. */
function reads(count: number): Call[] {
  return Array.from({ length: count }, () => ({
    input: { path: 'notes.md' },
    toolId: 'read_file',
  }));
}

/** A host whose runs make `calls`, one a step, under a 40,000-token budget, then answer. */
async function longRunHost(
  calls: readonly Call[],
  fixture: ChildRunFixture = {},
  bounds: (
    admission: HostRunAdmission,
    store: () => StateStore
  ) => Promise<Partial<HostRunAdmission>> = async () => ({})
) {
  const model = scriptedTurns(
    [{ answer: 'Read them all.', prompt: QUESTION, steps: calls.map((call) => [call]) }],
    SUMMARY
  );
  let store: StateStore | undefined;
  const harness = await setupChildRunHost(
    model,
    cleanup,
    { readFile: async () => ({ content: NOTES }), ...fixture },
    (platform) => async (request) => {
      const admitted = await recordingAdmission([])(platform)?.(request);
      if (!(admitted && store)) {
        throw new Error('The fixture admission admitted nothing');
      }
      const opened = store;
      const extra = await bounds(admitted, () => opened);
      const tools = extra.tools ?? admitted.tools;
      return {
        ...admitted,
        inputTokenLimit: 40_000,
        ...extra,
        snapshot: {
          ...admitted.snapshot,
          maxSteps: 40,
          toolIdentities: Object.fromEntries(
            Object.entries(tools).map(([id, tool]) => [id, tool.identity])
          ),
        },
        tools,
      };
    }
  );
  store = harness.store;
  return { harness, model };
}

test('a long run summarizes its older steps between two steps and carries on', async () => {
  const { harness, model } = await longRunHost(reads(12));
  const runId = await harness.start(QUESTION);
  const rows = await rowsUntil(harness, harness.threadId, finished(runId), 30_000);

  expect(rows.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });
  const [compaction, ...later] = compactions(rows);
  expect(compaction).toMatchObject({
    compactedRunIds: [],
    kind: 'agentic',
    reason: 'pre-request',
    runId,
    summary: SUMMARY,
    through: { runId, stepNumber: expect.any(Number) },
  });
  const through = compaction?.through?.stepNumber ?? -1;
  // The card sits between the run's steps: after the last one it replaced, before the next.
  const at = rows.findIndex((row) => row.event.type === 'context.compacted');
  const steps = rows.flatMap((row, index) =>
    row.event.type === 'model.step' ? [{ index, step: row.event.stepNumber }] : []
  );
  expect(steps.filter(({ index }) => index < at).at(-1)?.step).toBeGreaterThan(through);
  expect(steps.some(({ index }) => index > at)).toBe(true);
  expect(later.every((event) => (event.through?.stepNumber ?? 0) > through)).toBe(true);

  // Every request after it keeps the question and drops the replaced steps' calls.
  const last = model.doStreamCalls.at(-1);
  if (!last) {
    throw new Error('The run sent no request');
  }
  expect(userTexts(last)).toEqual([QUESTION]);
  expect(callIds(last)).not.toContain('turn-1-call-1');
  expect(callIds(last)).toContain('turn-1-call-12');
  // The request's provenance leaves them out too.
  const history = hostProviderHistory(rows, { runId, threadId: harness.threadId });
  const invocations = history.flatMap((message) =>
    message.content.parts.flatMap((part) =>
      part.type === 'tool-invocation' ? [part.toolInvocation.toolCallId] : []
    )
  );
  expect(invocations).not.toContain('turn-1-call-1');
  expect(invocations).toContain('turn-1-call-12');
});

test('a compaction committed before an approval pause holds after the run resumes', async () => {
  const { harness, model } = await longRunHost(
    [...reads(12), { input: { path: 'notes.md' }, toolId: 'write_file' }],
    {
      policy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask', read: 'allow' },
        yolo: false,
      }),
    }
  );
  // The run reads twelve times, then asks to write.
  const runId = await harness.start(QUESTION);
  const approval = async () =>
    (await harness.core().read(harness.threadId, 0))
      .map((row) => row.event)
      .find(
        (event): event is Extract<HostEvent, { type: 'interaction.requested' }> =>
          event.type === 'interaction.requested' && event.runId === runId
      );
  await expect.poll(approval, { timeout: 30_000 }).toBeDefined();
  expect(compactions(await harness.core().read(harness.threadId, 0)).length).toBeGreaterThan(0);
  // The host restarts while the approval waits, then the person approves.
  await harness.crash();
  const requested = await approval();
  if (!requested) {
    throw new Error('The approval was not committed');
  }
  await harness.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: requested.interactionId,
    runId,
    threadId: harness.threadId,
  });
  const rows = await rowsUntil(harness, harness.threadId, finished(runId), 30_000);
  expect(rows.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });
  const last = model.doStreamCalls.at(-1);
  expect(last && callIds(last)).not.toContain('turn-1-call-1');
  expect(last && callIds(last)).toContain('turn-1-call-13');
}, 60_000);

test('a tool loaded in a compacted step is still offered', async () => {
  const deferred: HostTool = {
    description: 'Inspect a symbol with the language server',
    execute: async () => ({ hover: 'const answer: 42' }),
    identity: 'native-lsp-generation-1',
    inputSchema: z.object({ path: z.string() }),
    permissionToolId: 'brainstrike.lspInspect',
    risk: 'read',
  };
  let discovered: readonly string[] = [];
  const { harness, model } = await longRunHost(
    [{ input: { toolName: 'brainstrike_lspInspect' }, toolId: 'load_tool' }, ...reads(12)],
    { tools: { brainstrike_lspInspect: deferred } },
    async (admitted, store) => {
      // Hosted discovery, as the production platform composes it over the committed log.
      const created = await createHostToolDiscovery({
        modelId: 'gpt-6-sol',
        provider: 'openai',
        readRunMessages: (key) => committedRunMessages(store(), key),
        tools: admitted.tools,
      });
      if (!created) {
        throw new Error('Nothing deferred behind discovery');
      }
      return {
        discovery: {
          activeTools: async (run) => {
            discovered = await created.discovery.activeTools(run);
            return [...discovered];
          },
          toolIds: created.discovery.toolIds,
        },
        tools: { ...admitted.tools, ...created.tools },
      };
    }
  );
  const runId = await harness.start(QUESTION);
  const rows = await rowsUntil(harness, harness.threadId, finished(runId), 30_000);
  const [compaction] = compactions(rows);
  // The load was step 0, which the compaction replaced.
  expect(compaction?.through?.stepNumber).toBeGreaterThanOrEqual(0);
  const last = model.doStreamCalls.at(-1);
  expect(last && callIds(last)).not.toContain('turn-1-call-1');
  expect((last?.tools ?? []).map((tool) => tool.name)).toContain('brainstrike_lspInspect');
  expect(discovered).toContain('brainstrike_lspInspect');
});

test('a request the provider boundary still trims commits a compaction that says so', async () => {
  const prompt = (label: string) => `${label} ${'p'.repeat(32_000)}`;
  const model = scriptedTurns(
    ['First', 'Second'].map((label) => ({ answer: `${label} answered.`, prompt: label, steps: [] }))
  );
  let store: StateStore | undefined;
  const harness = await setupChildRunHost(model, cleanup, {}, (platform) => async (request) => {
    const admitted = await recordingAdmission([])(platform)?.(request);
    if (!(admitted && store)) {
      throw new Error('The fixture admission admitted nothing');
    }
    // Each question is about 8,000 tokens; both turns stay protected, so nothing compacts first.
    return {
      ...admitted,
      inputTokenLimit: 15_000,
      providerRequest: { inputTokenLimit: 15_000, provider: 'openai' },
    };
  });
  store = harness.store;
  const firstRun = await harness.start(prompt('First'));
  await rowsUntil(harness, harness.threadId, finished(firstRun), 15_000);
  const secondRun = await harness.start(prompt('Second'));
  const rows = await rowsUntil(harness, harness.threadId, finished(secondRun), 15_000);

  expect(rows.find(finished(secondRun))?.event).toMatchObject({ outcome: 'completed' });
  expect(compactions(rows)).toEqual([
    {
      compactedRunIds: [firstRun],
      kind: 'deterministic',
      reason: 'request-trim',
      runId: secondRun,
      summary:
        'Deterministic fallback: dropped 1 earlier turns (2 messages) after a request over the input budget; no summarization model ran.',
      type: 'context.compacted',
    },
  ]);
  // It commits with the trimmed request's receipt.
  const trim = rows.findIndex((row) => row.event.type === 'context.compacted');
  expect(rows[trim - 1]?.event).toMatchObject({
    accounting: { removedMessages: 2 },
    type: 'provider.request.prepared',
  });
});
