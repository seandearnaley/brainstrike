import approvedRecording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import richRecording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import { hydratesHostEvent } from '../src/host-event-encoding.js';
import {
  foldLatestRun,
  HostLedgerProjection,
  mergeRootUsage,
  ThreadLedgerFold,
} from '../src/ledger-projection.js';
import { type HostLogRow, HostLogRowSchema } from '../src/protocol.js';

// Two recorded runs, each with an approved tool call and two model steps. The
// runtime shape commits a time on every row and a provider::model run model.
const MODEL = 'openrouter::anthropic/claude-sonnet-4.6';
const BASE = Date.parse('2026-10-08T12:00:00Z');
const rows: HostLogRow[] = richRecording.map((raw) => {
  const row = Schema.decodeUnknownSync(HostLogRowSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(raw);
  const event = row.event.type === 'run.started' ? { ...row.event, modelId: MODEL } : row.event;
  return { ...row, event, ts: BASE + row.seq * 1000 };
});
const threadId = rows[0]?.threadId ?? '';
/** The recording's model lists at $3 input / $15 output per million tokens. */
const usd = (inputTokens: number, outputTokens: number) =>
  expect.closeTo((inputTokens * 3 + outputTokens * 15) / 1e6, 12);
const started = rows.filter((row) => row.event.type === 'run.started');
const [first] = started;
if (first?.event.type !== 'run.started') {
  throw new Error('The recording has no run');
}
const { runId } = first.event;
function folded(log: readonly HostLogRow[]) {
  const fold = new ThreadLedgerFold();
  for (const row of log) {
    fold.apply(row);
  }
  return fold.read();
}
/** The recording, with `events` committed right after the first run starts. */
const insertAfterStart = (...events: Record<string, unknown>[]): HostLogRow[] => {
  const at = rows.indexOf(first) + 1;
  return [
    ...rows.slice(0, at),
    ...events.map((event) => ({ event, seq: 0, threadId })),
    ...rows.slice(at),
  ].map((row, index) =>
    Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
      ...row,
      seq: index + 1,
      ts: BASE + (index + 1) * 1000,
    })
  );
};
/** The recording with its first run's start replaced by `event`'s fields. */
const startedWith = (event: Record<string, unknown>): HostLogRow[] => {
  const replaced = Schema.decodeSync(HostLogRowSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({ ...first, event: { ...first.event, ...event } });
  return rows.map((row) => (row === first ? replaced : row));
};
test('a model step counts its calls before the stream copy arrives, without counting either twice', () => {
  const calls = rows.filter(
    ({ event }) =>
      event.type === 'stream.chunk' &&
      typeof event.chunk === 'object' &&
      event.chunk !== null &&
      !Array.isArray(event.chunk) &&
      event.chunk['type'] === 'tool-call'
  );
  expect(calls).toHaveLength(2);
  const committed = rows.filter((row) => !calls.includes(row));
  const fold = new ThreadLedgerFold();
  for (const row of committed) {
    fold.apply(row);
  }
  expect(fold.read().runs.map((run) => run.toolCallCount)).toEqual([1, 1]);
  for (const row of calls) {
    fold.apply(row);
  }
  expect(fold.read().runs.map((run) => run.toolCallCount)).toEqual([1, 1]);
});

test('a committed log folds into ledger runs and per-call usage', () => {
  const { runs, usage } = folded(rows);
  expect(runs).toHaveLength(2);
  const finished = rows.find(
    (row) => row.event.type === 'run.finished' && row.event.runId === runId
  );
  expect(runs.find((run) => run.runId === runId)).toEqual({
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    completedAt: finished?.ts,
    durationMs: (finished?.ts ?? 0) - (first.ts ?? 0),
    editCount: 0,
    estimatedCostUsd: usd(2, 50),
    estimatedInputTokens: 2,
    estimatedOutputTokens: 50,
    failedToolCallCount: 0,
    inputTokens: 2,
    model: 'anthropic/claude-sonnet-4.6',
    outcomeDetail: null,
    outcomeSource: null,
    outcomeVerdict: null,
    outputTokens: 50,
    provider: 'openrouter',
    revertedEditCount: 0,
    runId,
    startedAt: first.ts,
    status: 'completed',
    threadId,
    toolCallCount: 1,
    unreportedCallCount: 0,
  });
  // One usage record per committed model step, at its commit time.
  expect(usage).toHaveLength(4);
  expect(usage[0]).toEqual({
    at: rows.find((row) => row.event.type === 'model.step')?.ts,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: usd(1, 25),
    inputTokens: 1,
    model: 'anthropic/claude-sonnet-4.6',
    outputTokens: 25,
    provider: 'openrouter',
  });
});
test("a compaction summarizer's side call counts within its run and as a provider call", () => {
  // Core commits it before the run's first request: the run's own model and
  // the SDK totalUsage as reported.
  const { runs, usage } = folded(
    insertAfterStart({
      compactedRunIds: [runId],
      kind: 'agentic',
      modelId: MODEL,
      reason: 'pre-request',
      runId,
      summary: 'State: earlier turns were summarized.',
      type: 'context.compacted',
      usage: { inputTokens: 42, outputTokens: 9, totalTokens: 51 },
    })
  );
  expect(runs.find((run) => run.runId === runId)).toMatchObject({
    inputTokens: 44,
    outputTokens: 59,
  });
  expect(usage).toHaveLength(5);
  expect(usage[0]).toEqual({
    at: BASE + (rows.indexOf(first) + 2) * 1000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: usd(42, 9),
    inputTokens: 42,
    model: 'anthropic/claude-sonnet-4.6',
    outputTokens: 9,
    provider: 'openrouter',
  });
});
test("a run's title and Auto-review calls count within it, each under the model it ran on", () => {
  const title = {
    kind: 'thread-title',
    modelId: MODEL,
    runId,
    type: 'model.usage',
    usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 },
  };
  const review = {
    kind: 'auto-review',
    modelId: 'openrouter::google/gemini-2.5-flash',
    runId,
    type: 'model.usage',
    usage: { inputTokens: 600, outputTokens: 20, totalTokens: 620 },
  };
  const { perModel, runs, usage } = folded(insertAfterStart(title, review));
  expect(perModel).toMatchObject([
    { model: 'anthropic/claude-sonnet-4.6', runKind: 'thread-title' },
    { model: 'google/gemini-2.5-flash', runKind: 'auto-review' },
    { runKind: 'chat' },
  ]);
  expect(runs.find((run) => run.runId === runId)).toMatchObject({
    inputTokens: 722,
    outputTokens: 78,
  });
  expect(usage[0]).toMatchObject({ costUsd: usd(120, 8), inputTokens: 120, outputTokens: 8 });
  expect(usage).toHaveLength(6);
});
describe("a step's native web searches bill beside its tokens, at its provider's price per search", () => {
  // Anthropic's web search, swapped in under the catalog tool's sanitized name.
  const log = startedWith({ modelId: 'anthropic::claude-haiku-4-5' });
  // As the SDK commits them: the call carries `providerExecuted`, its result does not.
  const call = (toolCallId: string) => ({
    input: { query: 'q' },
    providerExecuted: true,
    toolCallId,
    toolName: 'brainstrike_webSearch',
    type: 'tool-call',
  });
  const result = (toolCallId: string, outputType: string) => ({
    output: { type: outputType, value: [] },
    toolCallId,
    toolName: 'brainstrike_webSearch',
    type: 'tool-result',
  });
  const stepCost = (content: readonly Record<string, unknown>[], usage: Record<string, unknown>) =>
    folded([
      ...log,
      Schema.decodeSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
        event: {
          messages: [{ content, role: 'assistant' }],
          model: { modelId: 'claude-haiku-4-5', provider: 'anthropic.messages' },
          runId,
          stepNumber: 9,
          type: 'model.step',
          usage: { inputTokens: 1000, outputTokens: 100, ...usage },
        },
        seq: log.length + 1,
        threadId,
        ts: BASE + (log.length + 1) * 1000,
      }),
    ]).usage.at(-1)?.costUsd;
  // Claude Haiku 4.5 lists at $1 input / $5 output per million tokens; a search is $0.01.
  const tokens = (1000 * 1 + 100 * 5) / 1e6;
  const searched = [
    call('srvtoolu_1'),
    result('srvtoolu_1', 'json'),
    // A client tool's call and result are the host's own work, never a provider search.
    { input: {}, toolCallId: 'call_2', toolName: 'brainstrike_webSearch', type: 'tool-call' },
    result('call_2', 'json'),
  ];

  test('each search that returned results, when the provider reports no count', () => {
    expect(stepCost(searched, {})).toBeCloseTo(tokens + 0.01, 12);
  });
  test('a failed search is not billed', () => {
    expect(
      stepCost([...searched, call('srvtoolu_2'), result('srvtoolu_2', 'error-json')], {})
    ).toBeCloseTo(tokens + 0.01, 12);
  });
  test("the provider's own count wins when it reports one", () => {
    const reported = { raw: { server_tool_use: { web_search_requests: 3 } } };
    expect(stepCost(searched, reported)).toBeCloseTo(tokens + 0.03, 12);
  });
});
describe('a call a Stop or failure cut off, which the provider never reported', () => {
  const second = started[1];
  if (second?.event.type !== 'run.started') {
    throw new Error('The recording has no second run');
  }
  const secondRunId = second.event.runId;
  const decode = Schema.decodeUnknownSync(HostLogRowSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  });
  const prepared = {
    accounting: { totalTokens: 1000 },
    modelId: MODEL,
    provider: 'openrouter',
    runId: secondRunId,
    type: 'provider.request.prepared',
  };
  const answered = {
    chunk: { request: {}, type: 'start-step', warnings: [] },
    runId: secondRunId,
    type: 'stream.chunk',
  };
  const finished = (outcome: string) => ({ outcome, runId: secondRunId, type: 'run.finished' });
  /** The second run (on `model`), cut at its last call: `events` replace that call's step and the end. */
  const unreported = (model: string, ...events: Record<string, unknown>[]) => {
    const lastStep = rows.findLastIndex(
      ({ event }) => event.type === 'model.step' && event.runId === secondRunId
    );
    const log = [
      ...rows.slice(0, lastStep),
      ...events.map((event) => ({ event, seq: 0, threadId })),
    ].map((row, index) => {
      const event =
        row.event.type === 'run.started' && row.event.runId === secondRunId
          ? { ...row.event, modelId: model }
          : row.event;
      return decode({ ...row, event, seq: index + 1, ts: BASE + (index + 1) * 1000 });
    });
    return folded(log).runs.find((run) => run.runId === secondRunId)?.unreportedCallCount;
  };

  test('a stopped call is counted as unreported, never as $0 or a guess', () => {
    expect(unreported(MODEL, prepared, answered, finished('stopped'))).toBe(1);
  });
  test('the step start that marks a call answered is replayed when the host reopens', () => {
    expect(hydratesHostEvent(decode({ event: answered, seq: 1, threadId, ts: BASE }).event)).toBe(
      true
    );
  });
  test('a call that failed after the provider answered is unreported too', () => {
    expect(unreported(MODEL, prepared, answered, finished('failed'))).toBe(1);
  });
  test('a stalled attempt the host replaced counts once, though its replacement succeeded', () => {
    const replacement = rows.find(
      ({ event }) => event.type === 'model.step' && event.runId === secondRunId
    )?.event;
    expect(
      unreported(MODEL, prepared, answered, prepared, replacement ?? {}, finished('completed'))
    ).toBe(1);
  });
  test('a request refused before the provider answered is billed by none', () => {
    expect(unreported(MODEL, prepared, finished('failed'))).toBe(0);
  });
  test('OpenAI does not bill a stream the client cut off', () => {
    expect(unreported('openai::gpt-6-luna', prepared, answered, finished('stopped'))).toBe(0);
  });
});
test('a run still open folds as running', () => {
  const second = started[1];
  if (!second) {
    throw new Error('The recording has no second run');
  }
  const { runs } = folded(rows.filter((row) => row.seq <= second.seq));
  expect(runs.find((run) => run.startedAt === second.ts)).toMatchObject({
    completedAt: null,
    durationMs: null,
    status: 'running',
  });
});
describe("a thread's per-model subtotals for the meter's thread total", () => {
  test('chat steps sum per model; the subtotals read stable until a costed call', () => {
    const fold = new ThreadLedgerFold();
    expect(fold.perModel()).toEqual([]);
    for (const row of rows) {
      fold.apply(row);
    }
    // Four recorded steps of 1 input / 25 output under the run's model.
    const perModel = fold.perModel();
    expect(perModel).toEqual([
      {
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        estimatedCostUsd: usd(4, 100),
        estimatedInputTokens: 4,
        estimatedOutputTokens: 100,
        inputTokens: 4,
        model: 'anthropic/claude-sonnet-4.6',
        outputTokens: 100,
        provider: 'openrouter',
        runKind: 'chat',
      },
    ]);
    // A streamed row is no costed call.
    const chunk = rows.find((row) => row.event.type === 'stream.chunk');
    if (!chunk) {
      throw new Error('The recording streamed nothing');
    }
    fold.apply({ ...chunk, seq: fold.seq + 1 });
    expect(fold.perModel()).toBe(perModel);
    expect(fold.read().perModel).toBe(perModel);
  });
  test('a compaction side call is its own source under the run model', () => {
    const { perModel } = folded(
      insertAfterStart({
        compactedRunIds: [runId],
        kind: 'agentic',
        modelId: MODEL,
        reason: 'pre-request',
        runId,
        summary: 'State: earlier turns were summarized.',
        type: 'context.compacted',
        usage: { inputTokens: 42, outputTokens: 9, totalTokens: 51 },
      })
    );
    expect(perModel).toMatchObject([
      { inputTokens: 42, outputTokens: 9, runKind: 'compaction-summary' },
      { inputTokens: 4, outputTokens: 100, runKind: 'chat' },
    ]);
  });
});
describe("the Task Ledger's and cost views' share of a host run", () => {
  const hash = (digit: string): string => digit.repeat(64);
  const edit = (entryId: string, path: string) => ({
    after: { existed: true, hash: hash('b'), size: 12 },
    baselines: [{ kind: 'absent', path }],
    before: { existed: false, hash: null, size: null },
    entryId,
    op: 'write',
    path,
    rootId: 'root-a',
    rootPath: '/tmp/workspace-a',
    runId,
    toolCallId: `call-${entryId}`,
    toolId: 'brainstrike.writeFile',
    type: 'workspace.edit.recorded',
  });
  test('its committed edits and reverts count in its ledger row, each revert once', () => {
    const revert = (commandId: string) => ({
      commandId,
      outcomes: [
        { entryId: 'edit-1', status: 'reverted' },
        { entryId: 'edit-2', reason: 'The file changed since the edit.', status: 'conflict' },
      ],
      runId,
      type: 'workspace.edit.reverted',
    });
    const { runs } = folded(
      insertAfterStart(
        edit('edit-1', 'notes.txt'),
        edit('edit-2', 'plan.md'),
        revert('revert-1'),
        revert('revert-2')
      )
    );
    expect(runs.find((run) => run.runId === runId)).toMatchObject({
      editCount: 2,
      revertedEditCount: 1,
    });
  });
  test("its provider calls count toward its bound root's cost; an unbound run's are unattributed", () => {
    const { rootUsage } = folded(
      startedWith({
        snapshot: {
          configuration: {},
          maxSteps: 12,
          toolIdentities: {},
          workspaceBinding: { operatingRootDisplayName: 'Workspace A', operatingRootId: 'root-a' },
        },
      })
    );
    // Each run commits two steps of 1 input / 25 output; unattributed first, as the SQL orders.
    expect(mergeRootUsage([rootUsage])).toEqual([
      {
        checkoutBranch: null,
        estimatedCostUsd: usd(2, 50),
        estimatedInputTokens: 2,
        estimatedOutputTokens: 50,
        inputTokens: 2,
        localRootId: null,
        model: 'anthropic/claude-sonnet-4.6',
        outputTokens: 50,
        provider: 'openrouter',
        rootDisplayName: null,
        rootId: null,
      },
      {
        checkoutBranch: null,
        estimatedCostUsd: usd(2, 50),
        estimatedInputTokens: 2,
        estimatedOutputTokens: 50,
        inputTokens: 2,
        localRootId: null,
        model: 'anthropic/claude-sonnet-4.6',
        outputTokens: 50,
        provider: 'openrouter',
        rootDisplayName: 'Workspace A',
        rootId: 'root-a',
      },
    ]);
  });
  test("a worktree run's calls carry its repository and branch beside the worktree root", () => {
    const { rootUsage } = folded(
      startedWith({
        snapshot: {
          configuration: {},
          maxSteps: 12,
          toolIdentities: {},
          workspaceBinding: {
            checkoutBranch: 'cost/ledger-redesign',
            checkoutLocalRootId: 'root-repo',
            checkoutMode: 'worktree',
            checkoutWorktreeId: 'wt-x7f3',
            checkoutWorktreePath: '/fixture/.worktrees/x7f3',
            operatingRootDisplayName: 'x7f3',
            operatingRootId: 'root-wt',
          },
        },
      })
    );
    expect(
      mergeRootUsage([rootUsage]).map(({ checkoutBranch, localRootId, rootId }) => [
        rootId,
        localRootId,
        checkoutBranch,
      ])
    ).toEqual([
      [null, null, null],
      ['root-wt', 'root-repo', 'cost/ledger-redesign'],
    ]);
  });
  test('threads sum per (root, provider, model) in the cross-root order', () => {
    const { rootUsage } = folded(rows);
    expect(mergeRootUsage([rootUsage, rootUsage])).toMatchObject([
      { inputTokens: 8, outputTokens: 200, rootId: null },
    ]);
  });
  test("an unbound run's provider calls count toward the root focused at its Send", () => {
    // The desktop's durable run configuration commits the Send intent, focused root included.
    const { rootUsage } = folded(
      startedWith({
        snapshot: {
          configuration: { intent: { selectionFolderId: 'root-b' } },
          maxSteps: 12,
          toolIdentities: {},
        },
      })
    );
    // The roots table names it; the run's log carries only its id.
    expect(
      mergeRootUsage([rootUsage]).map(({ rootDisplayName, rootId }) => [rootId, rootDisplayName])
    ).toEqual([
      [null, null],
      ['root-b', null],
    ]);
  });
});
describe('each provider call is priced on its own', () => {
  // Claude Haiku 5.5 lists $0.10 input / $0.50 output per million tokens, with
  // cache reads at $0.01, and charges $0.50 / $2.50 once ONE request's prompt
  // passes 100,000 tokens.
  const observed = (...usages: Record<string, unknown>[]) =>
    folded(
      insertAfterStart(
        ...usages.map((usage) => ({
          kind: 'auto-review',
          modelId: 'anthropic::claude-haiku-5-5',
          runId,
          type: 'model.usage',
          usage,
        }))
      )
    );
  test('two short requests stay at the standard rate though their sum passes the long-context threshold', () => {
    const call = { inputTokens: 60_000, outputTokens: 1000, totalTokens: 61_000 };
    const { perModel, runs, usage } = observed(call, call);
    // $0.0065 a call; pricing the 120,000-token sum as one request would read $0.065.
    expect(perModel.find((entry) => entry.runKind === 'auto-review')).toMatchObject({
      estimatedCostUsd: expect.closeTo(0.013, 12),
      inputTokens: 120_000,
    });
    expect(usage.slice(0, 2).map((entry) => entry.costUsd)).toEqual([
      expect.closeTo(0.0065, 12),
      expect.closeTo(0.0065, 12),
    ]);
    // The run's total prices its side calls under the model they ran on.
    expect(runs.find((run) => run.runId === runId)?.estimatedCostUsd).toBeCloseTo(
      0.013 + (2 * 3 + 50 * 15) / 1e6,
      12
    );
  });
  test('a long request pays the long-context rate', () => {
    const { usage } = observed({ inputTokens: 120_000, outputTokens: 1000, totalTokens: 121_000 });
    expect(usage[0]?.costUsd).toBeCloseTo(0.0625, 12);
  });
  test('a cached call records what its cache saved', () => {
    const { perModel } = observed({
      inputTokenDetails: { cacheReadTokens: 50_000 },
      inputTokens: 60_000,
      outputTokens: 1000,
      totalTokens: 61_000,
    });
    // $0.002 with the cache against $0.0065 without it.
    expect(perModel.find((entry) => entry.runKind === 'auto-review')).toMatchObject({
      cacheSavingsUsd: expect.closeTo(0.0045, 12),
      estimatedCostUsd: expect.closeTo(0.002, 12),
    });
  });
  test('a call pays the rates in force on the day it ran', () => {
    // Gemini 4 Argon lists $2 input / $10 output per million tokens until
    // 2026-12-01, then $4 / $20.
    const log = insertAfterStart({
      kind: 'auto-review',
      modelId: 'google::gemini-4-argon',
      runId,
      type: 'model.usage',
      usage: { inputTokens: 100_000, outputTokens: 1000, totalTokens: 101_000 },
    });
    const DEC_2_2026 = Date.parse('2026-12-02T12:00:00Z');
    const afterChange = log.map((row) => ({ ...row, ts: (row.ts ?? BASE) - BASE + DEC_2_2026 }));
    expect(folded(log).usage[0]?.costUsd).toBeCloseTo(0.21, 12);
    expect(folded(afterChange).usage[0]?.costUsd).toBeCloseTo(0.42, 12);
  });
  test('a call under a model with no list price leaves every total it joins unpriced', () => {
    const { perModel, runs, usage } = folded(
      insertAfterStart({
        kind: 'auto-review',
        modelId: 'openai::not-in-the-catalog',
        runId,
        type: 'model.usage',
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      })
    );
    expect(usage[0]?.costUsd).toBeNull();
    expect(perModel.find((entry) => entry.runKind === 'auto-review')?.estimatedCostUsd).toBeNull();
    expect(runs.find((run) => run.runId === runId)?.estimatedCostUsd).toBeNull();
  });
});
describe('a call OpenRouter billed costs what it billed', () => {
  // The recording's run commits two unbilled steps of 1 input / 25 output.
  const stepBilled = (raw: Record<string, unknown>) =>
    folded(
      insertAfterStart({
        messages: [],
        model: {},
        runId,
        stepNumber: 9,
        type: 'model.step',
        usage: {
          inputTokenDetails: { cacheReadTokens: 400 },
          inputTokens: 1000,
          outputTokens: 100,
          raw,
        },
      })
    );
  test('only its unbilled calls are estimated, in every cost view', () => {
    const { perModel, rootUsage, runs, usage } = stepBilled({ cost: 0.002, is_byok: false });
    expect(runs.find((run) => run.runId === runId)).toMatchObject({
      billedCostUsd: 0.002,
      cacheReadTokens: 400,
      estimatedCostUsd: usd(2, 50),
      estimatedInputTokens: 2,
      estimatedOutputTokens: 50,
      inputTokens: 1002,
      outputTokens: 150,
    });
    expect(perModel.find((entry) => entry.runKind === 'chat')).toMatchObject({
      billedCostUsd: 0.002,
      cacheReadTokens: 400,
      estimatedInputTokens: 4,
      inputTokens: 1004,
    });
    expect(mergeRootUsage([rootUsage])).toMatchObject([
      { billedCostUsd: 0.002, estimatedInputTokens: 4, inputTokens: 1004 },
    ]);
    expect(usage.filter((entry) => entry.billedCostUsd !== undefined)).toEqual([
      expect.objectContaining({ billedCostUsd: 0.002, inputTokens: 1000 }),
    ]);
  });
  test("a BYOK call costs OpenRouter's fee and what the provider billed the key", () => {
    const { runs } = stepBilled({
      cost: 0.0125,
      cost_details: { upstream_inference_cost: 0.25 },
      is_byok: true,
    });
    expect(runs.find((run) => run.runId === runId)?.billedCostUsd).toBeCloseTo(0.2625, 12);
  });
  test.each([
    ['reports no cost', { is_byok: false }],
    ["is BYOK without the provider's charge", { cost: 0.0125, is_byok: true }],
    ['reports a malformed cost', { cost: -1 }],
  ])('a call that %s is estimated', (_case, raw) => {
    const { runs } = stepBilled(raw);
    const run = runs.find((entry) => entry.runId === runId);
    expect(run).not.toHaveProperty('billedCostUsd');
    expect(run).toMatchObject({ estimatedInputTokens: 1002, estimatedOutputTokens: 150 });
  });
  test("another provider's usage is never read as a bill", () => {
    const { runs } = folded(
      insertAfterStart({
        kind: 'auto-review',
        modelId: 'anthropic::claude-haiku-5-5',
        runId,
        type: 'model.usage',
        usage: { inputTokens: 10, outputTokens: 1, raw: { cost: 1 } },
      })
    );
    expect(runs.find((run) => run.runId === runId)).not.toHaveProperty('billedCostUsd');
  });
});

describe("a thread's latest root run", () => {
  const approved = approvedRecording.map((row) =>
    Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })(row)
  );
  const indexOf = (log: readonly HostLogRow[], type: string): number => {
    const index = log.findIndex((row) => row.event.type === type);
    if (index < 0) {
      throw new Error(`The recording has no ${type}`);
    }
    return index;
  };
  const latest = (log: readonly HostLogRow[]) => log.reduce(foldLatestRun, undefined)?.run;
  /** The recording's last terminal row with `outcome` and a commit time, as Core commits it. */
  const finishedAs = (
    outcome: 'completed' | 'failed' | 'interrupted' | 'stopped',
    log: readonly HostLogRow[] = approved
  ): HostLogRow[] => {
    const last = log.findLastIndex((row) => row.event.type === 'run.finished');
    return log.map((row, index) =>
      index === last && row.event.type === 'run.finished'
        ? { ...row, event: { ...row.event, outcome }, ts: BASE }
        : row
    );
  };
  test('runs until its own finish; a recording without commit times invents no finish time', () => {
    // The real recording, as a log whose rows carry no commit times.
    const untimed = approved.map(({ ts: _ts, ...row }) => row);
    const open = untimed.slice(0, indexOf(untimed, 'run.finished'));
    expect(latest(open)).toEqual({
      completedAt: null,
      needsInput: false,
      seq: open.findLast((row) => row.event.type === 'interaction.responded')?.seq,
      startedAt: null,
      status: 'running',
    });
    expect(latest(untimed)).toEqual({
      completedAt: null,
      needsInput: false,
      seq: untimed[indexOf(untimed, 'run.finished')]?.seq,
      startedAt: null,
      status: 'completed',
    });
  });
  test('the latest of several runs decides; its start and finish are committed row times', () => {
    const second = rows.findLastIndex((row) => row.event.type === 'run.started');
    expect(latest(rows.slice(0, second + 1))).toMatchObject({
      startedAt: rows[second]?.ts,
      status: 'running',
    });
    expect(latest(finishedAs('failed', rows))).toMatchObject({
      completedAt: BASE,
      needsInput: false,
      startedAt: rows[second]?.ts,
      status: 'failed',
    });
  });
  test('outcomes read as the legacy run statuses: Stop is cancelled, an interruption failed', () => {
    expect(latest(finishedAs('stopped'))?.status).toBe('cancelled');
    expect(latest(finishedAs('interrupted'))?.status).toBe('failed');
  });
  test('a run waiting on its user needs input until the committed response', () => {
    expect(latest(approved.slice(0, indexOf(approved, 'interaction.requested') + 1))).toMatchObject(
      { needsInput: true, status: 'running' }
    );
    expect(
      latest(approved.slice(0, indexOf(approved, 'interaction.responded') + 1))?.needsInput
    ).toBe(false);
  });
  test('a waiting run names what it waits on, for as long as it waits', () => {
    const asked = indexOf(approved, 'interaction.requested');
    // The recording's request is a tool approval.
    expect(latest(approved.slice(0, asked + 1))?.waitingOn).toEqual(['approval']);
    // The same wait as a question: the thread list tells the two apart.
    const question = approved.map((row) =>
      row.event.type === 'interaction.requested'
        ? { ...row, event: { ...row.event, kind: 'question' as const } }
        : row
    );
    expect(latest(question.slice(0, asked + 1))?.waitingOn).toEqual(['question']);
    // Answered, it waits on nothing, and a finished run never does.
    const answered = latest(approved.slice(0, indexOf(approved, 'interaction.responded') + 1));
    expect(answered).not.toHaveProperty('waitingOn');
    expect(latest(approved)).not.toHaveProperty('waitingOn');
  });
});
describe("Core's projection of every thread", () => {
  test('lists each thread it folded until the thread is forgotten', () => {
    const projection = new HostLedgerProjection();
    for (const row of rows) {
      projection.apply(row);
    }
    expect(projection.read()).toEqual({ threads: [{ threadId, ...folded(rows) }] });
    expect(projection.readLatestRun(threadId)).toEqual(rows.reduce(foldLatestRun, undefined)?.run);
    projection.forget(threadId);
    expect(projection.read()).toEqual({ threads: [] });
    expect(projection.readLatestRun(threadId)).toBeUndefined();
  });
  test('a row its ledger cannot fold fails every ledger read, naming the thread and row', () => {
    const projection = new HostLedgerProjection();
    const step = rows.find((row) => row.event.type === 'model.step');
    if (step?.event.type !== 'model.step') {
      throw new Error('The recording has no model step');
    }
    // A usage the committed event admits (any JSON) but no token count reads.
    const unreadable = { ...step, event: { ...step.event, usage: { inputTokens: -1 } } };
    for (const row of rows.map((row) => (row === step ? unreadable : row))) {
      expect(() => projection.apply(row)).not.toThrow();
    }
    expect(() => projection.read()).toThrow(`Thread ${threadId} row ${step.seq} cannot be costed`);
    // The thread's run state still folds.
    expect(projection.readLatestRun(threadId)).toEqual(rows.reduce(foldLatestRun, undefined)?.run);
  });
});
