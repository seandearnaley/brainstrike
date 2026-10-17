import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import { type EvalAttempt, readRunFromLog, scoreEvalAttempt } from '../src/scoring.js';

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
        maxStepToolCalls: 1,
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

  test('an expect block holds the run to the parallel tool calls its log committed', () => {
    const metrics = (maxStepToolCalls: number) => ({
      approvals: 0,
      inputTokens: 1,
      maxStepToolCalls,
      outputTokens: 1,
      steps: 2,
      toolCalls: {},
      wallMs: 1,
    });
    const run = (calls: number) => ({ metrics: metrics(calls), verdict: completed.run!.verdict });
    const expecting = { expect: { maxStepToolCalls: 2 } };
    expect(scoreEvalAttempt({ ...completed, ...expecting, run: run(2) })).toEqual({ pass: true });
    expect(reasonOf({ ...completed, ...expecting, run: run(1) })).toMatch(
      /expects at least 2 tool calls in one step; the run made at most 1/u
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
