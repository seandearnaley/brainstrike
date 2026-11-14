import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import {
  type EvalAttempt,
  type EvalRunSummary,
  gradeProbe,
  readRunFromLog,
  readThreadFromLog,
  scoreEvalAttempt,
  threadMetrics,
} from '../src/scoring.js';

const require = createRequire(import.meta.url);

/** A real committed log: one approved write, then an answer. */
async function approvedRun() {
  const rows = Schema.decodeUnknownSync(Schema.Array(HostLogRowSchema))(
    JSON.parse(
      await readFile(
        require.resolve('@brainstrike/test-utils/fixtures/committed-approved-host-run.json'),
        'utf8'
      )
    )
  );
  const started = rows.find((row) => row.event.type === 'run.started');
  if (started?.event.type !== 'run.started') {
    throw new Error('The fixture has no run');
  }
  return { rows, runId: started.event.runId };
}

describe('readRunFromLog', () => {
  test('reads steps, tool calls, tokens, approvals, wall time and the verdict from the committed log', async () => {
    const { rows, runId } = await approvedRun();
    expect(readRunFromLog(rows, runId)).toEqual({
      metrics: {
        approvals: 1,
        inputTokens: 2,
        maxStepCallsByTool: { write_file: 1 },
        outputTokens: 2,
        steps: 2,
        toolCalls: { write_file: 1 },
        wallMs: 69,
      },
      modelId: 'scripted',
      runId,
      verdict: { outcome: 'completed' },
    });
  });

  test('a run with no run.finished is unfinished', async () => {
    const { rows, runId } = await approvedRun();
    const open = rows.filter((row) => row.event.type !== 'run.finished');
    expect(readRunFromLog(open, runId)).toMatchObject({
      metrics: { wallMs: null },
      verdict: { outcome: 'unfinished' },
    });
  });

  test('a step without reported usage leaves the token totals unknown, not zero', async () => {
    const { rows, runId } = await approvedRun();
    const unreported = rows.map((row) =>
      row.event.type === 'model.step' ? { ...row, event: { ...row.event, usage: {} } } : row
    );
    expect(readRunFromLog(unreported, runId).metrics).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
  });

  test('refuses a run the log never started', async () => {
    const { rows } = await approvedRun();
    expect(() => readRunFromLog(rows, 'not-a-run')).toThrow(/not-a-run/u);
  });
});

/** The reason a failing attempt scores, or undefined when it passes. */
function reasonOf(attempt: EvalAttempt): string | undefined {
  const score = scoreEvalAttempt(attempt);
  return score.pass ? undefined : score.reason;
}

describe('scoreEvalAttempt', () => {
  const boundary = { refusals: [], unserved: [] };
  const unverified: EvalAttempt = { boundary, run: { verdict: { outcome: 'completed' } } };
  const completed: EvalAttempt = { ...unverified, verifier: { exitCode: 0, output: '' } };

  test('passes only a completed run, a clean provider boundary and a verifier that exits 0', () => {
    expect(scoreEvalAttempt(completed)).toEqual({ pass: true });
  });

  test.each<[string, EvalAttempt, RegExp]>([
    [
      'a host error',
      { ...completed, hostError: 'host start failed: boom' },
      /host start failed: boom/u,
    ],
    ['a timeout', { ...completed, timedOut: 60_000 }, /timed out after 60000 ms/u],
    ['no run at all', { boundary }, /no run/u],
    [
      'a failed run',
      { ...completed, run: { verdict: { detail: 'provider 500', outcome: 'failed' } } },
      /run failed: provider 500/u,
    ],
    [
      'an unfinished run',
      { ...completed, run: { verdict: { outcome: 'unfinished' } } },
      /unfinished/u,
    ],
    [
      'a refused provider request',
      {
        ...completed,
        boundary: { refusals: ['OPENAI_BASE_URL/responses gpt-6 #3'], unserved: [] },
      },
      /refused 1 provider request.*gpt-6 #3/u,
    ],
    [
      'an unserved cassette exchange',
      { ...completed, boundary: { refusals: [], unserved: ['title #1'] } },
      /left 1 recorded exchange\(s\) unserved.*title #1/u,
    ],
    ['a verifier that never ran', unverified, /verifier did not run/u],
    [
      'a verifier that exits 1',
      { ...completed, verifier: { exitCode: 1, output: 'expected 3, got 2' } },
      /verifier exited 1: expected 3, got 2/u,
    ],
  ])('fails %s, with its reason', (_name, attempt, reason) => {
    expect(scoreEvalAttempt(attempt).pass).toBe(false);
    expect(reasonOf(attempt)).toMatch(reason);
  });

  test('an expect block holds the run to parallel calls of the named tool', () => {
    const run = (maxStepCallsByTool: Record<string, number>) => ({
      metrics: {
        approvals: 0,
        inputTokens: 1,
        maxStepCallsByTool,
        outputTokens: 1,
        steps: 2,
        toolCalls: {},
        wallMs: 1,
      },
      verdict: completed.run!.verdict,
    });
    const expecting = {
      expect: { parallelCalls: { atLeast: 2, toolId: 'brainstrike_readWorkspaceFile' } },
    };
    expect(
      scoreEvalAttempt({
        ...completed,
        ...expecting,
        run: run({ brainstrike_readWorkspaceFile: 2 }),
      })
    ).toEqual({ pass: true });
    // Two calls in one step, but of different tools, then the reads one at a time.
    expect(
      reasonOf({
        ...completed,
        ...expecting,
        run: run({ brainstrike_manageTaskList: 1, brainstrike_readWorkspaceFile: 1 }),
      })
    ).toMatch(
      /at least 2 brainstrike_readWorkspaceFile calls in one step; the run made at most 1/u
    );
    expect(reasonOf({ ...completed, ...expecting })).toMatch(/reported no metrics/u);
  });

  test('a refused provider request outranks the failed run it caused', () => {
    expect(
      reasonOf({
        ...completed,
        boundary: {
          refusals: ['unrecorded exchange POST OPENAI_BASE_URL/responses'],
          unserved: [],
        },
        run: { verdict: { detail: 'HTTP 401', outcome: 'failed' } },
      })
    ).toMatch(/^The provider boundary refused 1/u);
  });

  test('a host error outranks every later finding', () => {
    expect(
      reasonOf({ ...completed, hostError: 'attach failed', verifier: { exitCode: 1, output: '' } })
    ).toMatch(/^attach failed/u);
  });
});

describe('readThreadFromLog', () => {
  /** The fixture's run under an eval's own model id: every eval run names a `provider::model`. */
  async function scriptedRun() {
    const { rows, runId } = await approvedRun();
    return {
      rows: rows.map((row) =>
        row.event.type === 'run.started'
          ? { ...row, event: { ...row.event, modelId: 'scripted::fix-failing-test' } }
          : row
      ),
      runId,
    };
  }

  /** That thread with more committed rows for its run. */
  async function withEvents(events: (runId: string) => readonly object[]) {
    const { rows, runId } = await scriptedRun();
    const last = rows.at(-1)!;
    const added = events(runId).map((event, index) => ({
      event,
      seq: last.seq + index + 1,
      threadId: last.threadId,
      ts: last.ts! + index + 1,
    }));
    return {
      rows: Schema.decodeUnknownSync(Schema.Array(HostLogRowSchema))([...rows, ...added]),
      runId,
    };
  }

  test("reads each turn's final answer, in turn order", async () => {
    const { rows, runId } = await approvedRun();
    expect(readThreadFromLog(rows, [runId])).toMatchObject({
      answers: ['Host run completed.'],
      compactions: { agentic: 0, deterministic: 0 },
      runs: [{ runId, verdict: { outcome: 'completed' } }],
    });
  });

  test('counts committed compactions by whether a model summarized them', async () => {
    const compacted = (runId: string, kind: 'agentic' | 'deterministic') => ({
      compactedRunIds: [runId],
      kind,
      reason: 'pre-request',
      runId,
      summary: 'Goal:\nNone.',
      type: 'context.compacted',
    });
    const { rows, runId } = await withEvents((id) => [
      compacted(id, 'agentic'),
      compacted(id, 'agentic'),
      compacted(id, 'deterministic'),
    ]);
    expect(readThreadFromLog(rows, [runId]).compactions).toEqual({ agentic: 2, deterministic: 1 });
  });

  test('spend counts every call the thread paid for, by what the call was for', async () => {
    const { rows, runId } = await withEvents((id) => [
      {
        compactedRunIds: [id],
        kind: 'agentic',
        modelId: 'openai::gpt-6-luna',
        reason: 'pre-request',
        runId: id,
        summary: 'Goal:\nNone.',
        type: 'context.compacted',
        usage: {
          inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 0, noCacheTokens: 60 },
          inputTokens: 100,
          outputTokens: 20,
        },
      },
    ]);
    const { spend } = readThreadFromLog(rows, [runId]);
    expect(spend.bySource['chat']).toMatchObject({ inputTokens: 2, outputTokens: 2 });
    expect(spend.bySource['compaction-summary']).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(spend.cacheReadTokens).toBe(40);
    // The summarizer ran on a catalog model, so its call has a list price.
    expect(spend.bySource['compaction-summary']?.costUsd).toBeGreaterThan(0);
  });

  test('a call the provider bills but never reported leaves the total unknown, and is counted', async () => {
    const { rows, runId } = await approvedRun();
    const finished = rows.at(-1)!;
    // A priced run whose last request was sent, then stopped before any usage came back.
    const cutOff = Schema.decodeUnknownSync(Schema.Array(HostLogRowSchema))([
      ...rows
        .slice(0, -1)
        .map((row) =>
          row.event.type === 'run.started'
            ? { ...row, event: { ...row.event, modelId: 'anthropic::claude-haiku-4-5' } }
            : row
        ),
      {
        event: {
          accounting: {
            measurement: {
              charactersPerToken: 4,
              mode: 'deterministic-serialized-character-backstop',
            },
            promptTokens: 10,
            removedMessages: 0,
            toolTokens: 5,
            totalTokens: 15,
            usedBackstop: false,
          },
          breakdown: {
            attachmentsCount: 0,
            historyMessagesTokens: 5,
            provenance: 'heuristic',
            systemInstructionsTokens: 5,
            toolCallsByTool: [],
            toolCallsTokens: 0,
            toolDefinitionsProvenance: 'heuristic',
            toolDefinitionsTokens: 5,
          },
          modelId: 'claude-haiku-4-5',
          provider: 'anthropic',
          runId,
          toolCallWindow: { base: 'previous', removed: [], upserted: [] },
          type: 'provider.request.prepared',
        },
        seq: finished.seq,
        threadId: finished.threadId,
        ts: finished.ts,
      },
      { ...finished, event: { ...finished.event, outcome: 'stopped' }, seq: finished.seq + 1 },
    ]);
    const { spend } = readThreadFromLog(cutOff, [runId]);
    expect(spend.unreportedCalls).toBe(1);
    expect(spend.costUsd).toBeNull();
    // The calls that did report still have their price.
    expect(spend.bySource['chat']?.costUsd).toBeGreaterThan(0);
  });

  test('a thread with an unpriced call has no total cost, rather than a partial one', async () => {
    const { rows, runId } = await scriptedRun();
    // A scripted model has no list price.
    expect(readThreadFromLog(rows, [runId]).spend.costUsd).toBeNull();
  });
});

describe('gradeProbe', () => {
  const probe = { facts: ['8443', 'src/server.ts'] };

  test('an answer that states every fact misses none', () => {
    expect(gradeProbe('We settled on port 8443, set in src/server.ts.', probe)).toEqual({
      missing: [],
    });
  });

  test('names each fact the answer leaves out', () => {
    expect(gradeProbe('We settled on port 8443.', probe)).toEqual({ missing: ['src/server.ts'] });
  });

  test('reads a fact whatever its letter case', () => {
    expect(gradeProbe('See SRC/Server.ts on 8443', probe)).toEqual({ missing: [] });
  });
});

describe('scoring a thread of several turns', () => {
  const done = { verdict: { outcome: 'completed' as const } };
  const thread = (answers: string[], compactions = { agentic: 0, deterministic: 0 }) => ({
    answers,
    compactions,
    runs: answers.map(() => done),
  });
  const base: EvalAttempt = {
    boundary: { refusals: [], unserved: [] },
    followUps: [{}, { probe: { facts: ['8443'] } }],
    run: done,
    verifier: { exitCode: 0, output: '' },
  };

  test('passes when every turn completed and the probe is answered', () => {
    expect(scoreEvalAttempt({ ...base, thread: thread(['ok', 'ok', 'Port 8443.']) })).toEqual({
      pass: true,
    });
  });

  test('fails a follow-up turn that did not complete, naming the turn', () => {
    const failed = { verdict: { detail: 'provider 500', outcome: 'failed' as const } };
    expect(reasonOf({ ...base, thread: { ...thread(['ok', '']), runs: [done, failed] } })).toMatch(
      /Turn 2 failed: provider 500/u
    );
  });

  test('fails a follow-up turn that never ran', () => {
    expect(reasonOf({ ...base, thread: thread(['ok', 'ok']) })).toMatch(/Turn 3 never ran/u);
  });

  test('fails a probe whose answer leaves a fact out, naming the turn and the fact', () => {
    expect(reasonOf({ ...base, thread: thread(['ok', 'ok', 'I do not recall.']) })).toMatch(
      /Turn 3's answer leaves out: 8443/u
    );
  });

  test('an expect block reads parallel calls from any turn of the thread', () => {
    const metrics = (maxStepCallsByTool: Record<string, number>) => ({
      approvals: 0,
      inputTokens: 1,
      maxStepCallsByTool,
      outputTokens: 1,
      steps: 2,
      toolCalls: {},
      wallMs: 1,
    });
    const expecting: EvalAttempt = {
      ...base,
      expect: { parallelCalls: { atLeast: 2, toolId: 'read' } },
      // Turn 1 read one file at a time.
      run: { ...done, metrics: metrics({ read: 1 }) },
    };
    const answers = ['ok', 'ok', 'Port 8443.'];
    expect(
      scoreEvalAttempt({
        ...expecting,
        thread: { ...thread(answers), metrics: metrics({ read: 2 }) },
      })
    ).toEqual({ pass: true });
    expect(
      reasonOf({ ...expecting, thread: { ...thread(answers), metrics: metrics({ read: 1 }) } })
    ).toMatch(/at least 2 read calls in one step; the run made at most 1/u);
  });

  test('an expect block holds the thread to a number of compactions', () => {
    const expecting = { ...base, expect: { compactions: { atLeast: 2 } } };
    const answers = ['ok', 'ok', 'Port 8443.'];
    expect(
      scoreEvalAttempt({ ...expecting, thread: thread(answers, { agentic: 1, deterministic: 1 }) })
    ).toEqual({ pass: true });
    expect(
      reasonOf({ ...expecting, thread: thread(answers, { agentic: 1, deterministic: 0 }) })
    ).toMatch(/expects at least 2 compaction\(s\); the thread committed 1/u);
  });
});

describe('threadMetrics', () => {
  const run = (metrics: Partial<EvalRunSummary['metrics']>): EvalRunSummary => ({
    metrics: {
      approvals: 1,
      inputTokens: 10,
      maxStepCallsByTool: {},
      outputTokens: 5,
      steps: 2,
      toolCalls: {},
      wallMs: 100,
      ...metrics,
    },
    modelId: 'scripted::fix-failing-test',
    runId: 'run',
    verdict: { outcome: 'completed' },
  });

  test("sums every turn's counts and keeps the widest step of any turn", () => {
    expect(
      threadMetrics([
        run({ maxStepCallsByTool: { read: 3 }, toolCalls: { read: 3, write: 1 } }),
        run({ maxStepCallsByTool: { read: 1, write: 2 }, toolCalls: { write: 2 } }),
      ])
    ).toEqual({
      approvals: 2,
      inputTokens: 20,
      maxStepCallsByTool: { read: 3, write: 2 },
      outputTokens: 10,
      steps: 4,
      toolCalls: { read: 3, write: 3 },
      wallMs: 200,
    });
  });

  test('a turn that reported no tokens leaves the thread total unknown', () => {
    expect(threadMetrics([run({}), run({ inputTokens: null })])).toMatchObject({
      inputTokens: null,
      outputTokens: 10,
    });
  });

  test('a thread with no run has no metrics', () => {
    expect(threadMetrics([])).toBeUndefined();
  });
});
