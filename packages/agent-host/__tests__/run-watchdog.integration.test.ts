import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  committedTextDeltas,
  finishedRun,
  probeTool,
  stop,
  stubResilience,
  type Timeline,
  text,
  timedModel,
  usage,
} from './fixtures/timed-host-run.js';

// Watchdog proofs only: recovery is off, so every expiry is terminal.
beforeEach(() => stubResilience({ BRAINSTRIKE_STREAM_STALL_ATTEMPTS: '1' }));
afterEach(() => vi.unstubAllEnvs());

test('a provider that never answers fails after the first-output window and is cancelled', async () => {
  const { aborted, model } = timedModel([[]]);
  const { terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toBe(
    'The model produced no output within 1500ms of the request starting.'
  );
  expect(aborted()).toBe(1);
});

test('a stream that goes quiet mid-answer fails after the inter-output window', async () => {
  const { aborted, model } = timedModel([
    [
      { id: 'text-1', type: 'text-start' },
      { delta: 'Partial', id: 'text-1', type: 'text-delta' },
    ],
  ]);
  const { rows, terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toBe('The model stream stalled after 1000ms without output.');
  expect(committedTextDeltas(rows)).toEqual(['Partial']);
  expect(aborted()).toBe(1);
});

test('a stream that stops mid-reasoning fails after the reasoning-gap window', async () => {
  const { model } = timedModel([
    [
      { id: 'reasoning-1', type: 'reasoning-start' },
      { delta: 'Thinking', id: 'reasoning-1', type: 'reasoning-delta' },
    ],
  ]);
  const { terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toBe(
    'The model stopped mid-reasoning, producing nothing further for 4000ms. Retry, or lower the reasoning effort if it recurs.'
  );
});

test('a reasoning pause and a running tool may outlast the inter-output window', async () => {
  const { model } = timedModel([
    [
      { id: 'reasoning-1', type: 'reasoning-start' },
      { delta: 'Thinking', id: 'reasoning-1', type: 'reasoning-delta' },
      2000,
      { delta: ' more', id: 'reasoning-1', type: 'reasoning-delta' },
      { id: 'reasoning-1', type: 'reasoning-end' },
      {
        input: JSON.stringify({ text: 'look' }),
        toolCallId: 'recorded-call-1',
        toolName: 'probe',
        type: 'tool-call',
      },
      { finishReason: { raw: 'tool_use', unified: 'tool-calls' }, type: 'finish', usage },
    ],
    [...text('Done.'), stop],
  ]);
  const { rows, terminal } = await finishedRun(model, probeTool(2500));
  expect(terminal.detail).toBeUndefined();
  expect(terminal.outcome).toBe('completed');
  expect(rows.some((row) => row.event.type === 'effect.finished')).toBe(true);
});

test('a tool call whose arguments never finish streaming fails before it executes', async () => {
  const deltas = Array.from(
    { length: 40 },
    (): Timeline => [300, { delta: ' ', id: 'call-1', type: 'tool-input-delta' }]
  ).flat();
  const { aborted, model } = timedModel([
    [
      { id: 'call-1', toolName: 'probe', type: 'tool-input-start' },
      { delta: '{"text":', id: 'call-1', type: 'tool-input-delta' },
      ...deltas,
    ],
  ]);
  const { rows, terminal } = await finishedRun(model, probeTool(0));
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toBe(
    "The model did not finish streaming a tool call's arguments within 2000ms. The incomplete tool call was cancelled before execution."
  );
  expect(rows.some((row) => row.event.type === 'effect.started')).toBe(false);
  expect(aborted()).toBe(1);
});
