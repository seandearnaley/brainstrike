import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { HostEvent, HostLogRow } from '../src/protocol.js';
import { captureHostFailureDiagnostics } from './fixtures/host-failure-diagnostics.js';
import {
  type Chunk,
  committedRunText,
  finishedRun,
  probeTool,
  stop,
  stubResilience,
  text,
  timedModel,
} from './fixtures/timed-host-run.js';

type Attempt = Extract<HostEvent, { type: 'run.attempt' }>;

// The legacy default budget: two provider attempts per run leg.
beforeEach(() => stubResilience());
afterEach(() => vi.unstubAllEnvs());

function attempts(rows: readonly HostLogRow[]): Attempt[] {
  return rows.flatMap((row) => (row.event.type === 'run.attempt' ? [row.event] : []));
}

const firstOutputStall = 'The model produced no output within 1500ms of the request starting.';

test('a first-output stall is re-attempted over the committed branch and the run completes', async () => {
  const { aborted, calls, model } = timedModel([[], [...text('Recovered.'), stop]]);
  const { rows, terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('completed');
  expect(calls()).toBe(2);
  expect(aborted()).toBe(1);
  expect(attempts(rows)).toEqual([
    expect.objectContaining({
      attempt: 1,
      detail: firstOutputStall,
      maxAttempts: 2,
      reason: 'stalled',
      recovered: true,
      stall: expect.objectContaining({ phase: 'awaiting-output' }),
    }),
  ]);
  expect(attempts(rows)[0]).not.toHaveProperty('refusal');
});

test('a stall after partial text is re-attempted; the recovered attempt owns the text', async () => {
  const { calls, model } = timedModel([
    [
      { id: 'text-1', type: 'text-start' },
      { delta: 'Partial', id: 'text-1', type: 'text-delta' },
    ],
    [...text('Recovered.'), stop],
  ]);
  const { rows, terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('completed');
  expect(calls()).toBe(2);
  // The stalled attempt's partial was live telemetry; a replaced attempt is not an
  // aborted turn, so only the recovered step's committed text remains (legacy).
  expect(committedRunText(rows)).toBe('Recovered.');
  expect(attempts(rows)).toEqual([
    expect.objectContaining({
      reason: 'stalled',
      recovered: true,
      stall: { lastPartType: 'text-delta', partsSeen: expect.any(Number), phase: 'streaming' },
    }),
  ]);
  // The run's committed record precedes the second attempt's stream.
  const attemptSeq = rows.find((row) => row.event.type === 'run.attempt')?.seq ?? 0;
  const recoveredSeq =
    rows.find(
      (row) => row.event.type === 'model.step' && JSON.stringify(row.event).includes('Recovered.')
    )?.seq ?? 0;
  expect(attemptSeq).toBeGreaterThan(0);
  expect(recoveredSeq).toBeGreaterThan(attemptSeq);
});

test('a stall on every attempt ends visibly once the budget is spent', async () => {
  const { calls, model } = timedModel([[]]);
  const { rows, terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toBe(firstOutputStall);
  expect(calls()).toBe(2);
  expect(attempts(rows)).toEqual([
    expect.objectContaining({ attempt: 1, recovered: true }),
    expect.objectContaining({ attempt: 2, recovered: false, refusal: 'budget-exhausted' }),
  ]);
});

test('a stall after the open step streamed tool input is never re-attempted', async () => {
  const { calls, model } = timedModel([
    [
      { id: 'call-1', toolName: 'probe', type: 'tool-input-start' },
      { delta: '{"text":', id: 'call-1', type: 'tool-input-delta' },
    ],
    [...text('Must not run.'), stop],
  ]);
  const { rows, terminal } = await finishedRun(model, probeTool(0));
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toBe('The model stream stalled after 1000ms without output.');
  expect(calls()).toBe(1);
  expect(rows.some((row) => row.event.type === 'effect.started')).toBe(false);
  expect(attempts(rows)).toEqual([
    expect.objectContaining({ reason: 'stalled', recovered: false, refusal: 'tool-parts' }),
  ]);
});

// A provider stream error part before any output, as an SSE `overloaded_error`
// event reaches the SDK; the SDK normalizes it to a retryable provider error.
const overloaded: Chunk = {
  error: { message: 'Overloaded', type: 'overloaded_error' },
  type: 'error',
};

test('a retryable provider error before any output is re-attempted', async () => {
  const diagnostics = captureHostFailureDiagnostics();
  const { calls, model } = timedModel([[overloaded], [...text('Recovered.'), stop]]);
  const { rows, terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('completed');
  expect(calls()).toBe(2);
  diagnostics.expectCause('Overloaded');
  expect(attempts(rows)).toEqual([
    expect.objectContaining({
      attempt: 1,
      detail: 'The provider could not complete this request. Provider response: Overloaded',
      maxAttempts: 2,
      reason: 'provider-error',
      recovered: true,
    }),
  ]);
});

test('a retryable provider error after output is not re-attempted', async () => {
  const { calls, model } = timedModel([
    [
      { id: 'text-1', type: 'text-start' },
      { delta: 'Par', id: 'text-1', type: 'text-delta' },
      overloaded,
    ],
    [...text('Must not run.'), stop],
  ]);
  const { rows, terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('failed');
  expect(calls()).toBe(1);
  expect(attempts(rows)).toEqual([
    expect.objectContaining({ recovered: false, refusal: 'committed-output' }),
  ]);
});

test('a non-retryable provider error is not an attempt failure', async () => {
  const diagnostics = captureHostFailureDiagnostics();
  const { calls, model } = timedModel([
    [{ error: { message: 'Malformed request.', type: 'invalid_request_error' }, type: 'error' }],
  ]);
  const { rows, terminal } = await finishedRun(model);
  expect(terminal).toMatchObject({ detail: INTERNAL_FAULT.message, outcome: 'failed' });
  diagnostics.expectCause('Malformed request.');
  expect(calls()).toBe(1);
  expect(attempts(rows)).toEqual([]);
});

test('an empty reply is re-attempted, and a second empty reply fails visibly', async () => {
  const recovered = timedModel([[stop], [...text('Recovered.'), stop]]);
  const first = await finishedRun(recovered.model);
  expect(first.terminal.outcome).toBe('completed');
  expect(attempts(first.rows)).toEqual([
    expect.objectContaining({ reason: 'empty-response', recovered: true }),
  ]);

  const empty = timedModel([[stop]]);
  const second = await finishedRun(empty.model);
  expect(second.terminal.outcome).toBe('failed');
  expect(second.terminal.detail).toMatch(/returned an empty response/u);
  expect(empty.calls()).toBe(2);
});
