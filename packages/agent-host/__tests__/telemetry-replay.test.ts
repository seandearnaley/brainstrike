/**
 * Core keeps a running call's telemetry, and the open step's text and
 * reasoning, in a bounded in-memory ring so a view that subscribes late is
 * replayed what it missed (ADR-0011 amendment). Nothing here is committed.
 */
import { randomUUID } from 'node:crypto';
import {
  SHELL_OUTPUT_STREAM_PART_TYPE,
  TOOL_TELEMETRY_OMITTED_TYPE,
} from '@brainstrike/assistant-contract';
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { type HostLogRow, HostLogRowSchema, type HostRunTelemetry } from '../src/protocol.js';
import { HostTelemetryReplay } from '../src/telemetry-replay.js';

const threadId = randomUUID();
const runId = randomUUID();
let seq = 0;
const row = (event: Record<string, unknown>, thread = threadId): HostLogRow =>
  Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
    event,
    seq: ++seq,
    threadId: thread,
  });
const slice = (toolCallId: string, chunk: string, thread = threadId): HostRunTelemetry => ({
  chunk: { chunk, stream: 'stdout', toolCallId, type: SHELL_OUTPUT_STREAM_PART_TYPE },
  runId,
  threadId: thread,
  toolCallId,
});
const text = (delta: string): HostRunTelemetry => ({
  chunk: { id: 'text-1', text: delta, type: 'text-delta' },
  runId,
  threadId,
});
const startStep = () =>
  row({ chunk: { type: 'start-step', warnings: [] }, runId, type: 'stream.chunk' });
const modelStep = (stepNumber: number) =>
  row({ messages: [], model: {}, runId, stepNumber, type: 'model.step', usage: {} });
const bytes = (telemetry: HostRunTelemetry) =>
  Buffer.byteLength(JSON.stringify(telemetry.chunk), 'utf8');
test("a call's chunks are numbered and replayed in order until its result commits", () => {
  const replay = new HostTelemetryReplay();
  const first = replay.record(slice('call-1', 'one\n'));
  const second = replay.record(slice('call-1', 'two\n'));
  const other = replay.record(slice('call-2', 'other\n'));
  expect([first.ordinal, second.ordinal, other.ordinal]).toEqual([0, 1, 0]);
  expect(replay.replay(threadId)).toEqual([first, second, other]);
  expect(replay.replay(randomUUID())).toEqual([]);
  replay.committed(
    row({ output: { exitCode: 0 }, runId, toolCallId: 'call-1', type: 'effect.finished' })
  );
  expect(replay.replay(threadId)).toEqual([other]);
  replay.committed(row({ outcome: 'completed', runId, type: 'run.finished' }));
  expect(replay.replay(threadId)).toEqual([]);
});
test('the bound drops the oldest chunks and a replay opens with a visible omission marker', () => {
  const chunks = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].map((value) =>
    slice('call-1', value)
  );
  const limit = bytes(chunks[1] as HostRunTelemetry) * 2;
  const replay = new HostTelemetryReplay(limit);
  const numbered = chunks.map((chunk) => replay.record(chunk));
  expect(replay.replay(threadId)).toEqual([
    {
      chunk: {
        omittedBytes: bytes(chunks[0] as HostRunTelemetry),
        resumesAt: 1,
        toolCallId: 'call-1',
        type: TOOL_TELEMETRY_OMITTED_TYPE,
      },
      runId,
      threadId,
      toolCallId: 'call-1',
    },
    numbered[1],
    numbered[2],
  ]);
});
test("the open step's text is kept from its start-step until its model.step commits", () => {
  const replay = new HostTelemetryReplay();
  // A delta before any committed step opens is sent live but not kept.
  expect(replay.record(text('early')).ordinal).toBe(0);
  expect(replay.replay(threadId)).toEqual([]);
  replay.committed(startStep());
  const kept = [replay.record(text('Hello')), replay.record(text(' world'))];
  expect(kept.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
  expect(replay.replay(threadId)).toEqual(kept);
  replay.committed(modelStep(0));
  expect(replay.replay(threadId)).toEqual([]);
  // A straggling delta after its step committed belongs to no open step.
  replay.record(text('late'));
  expect(replay.replay(threadId)).toEqual([]);
  replay.committed(startStep());
  const next = replay.record(text('Next'));
  expect(next.ordinal).toBe(4);
  expect(replay.replay(threadId)).toEqual([next]);
  replay.committed(row({ outcome: 'stopped', runId, type: 'run.finished' }));
  expect(replay.replay(threadId)).toEqual([]);
});
test("a Stop's partial reply commits the open step's text and drops it", () => {
  const replay = new HostTelemetryReplay();
  replay.committed(startStep());
  replay.record(text('partial'));
  replay.committed(row({ messages: [], runId, type: 'model.messages' }));
  expect(replay.replay(threadId)).toEqual([]);
});
test("a step's text over the bound replays from a marker that names no call", () => {
  const deltas = ['x'.repeat(30), 'y'.repeat(30), 'z'.repeat(30)].map(text);
  const replay = new HostTelemetryReplay(bytes(deltas[0] as HostRunTelemetry) * 2);
  replay.committed(startStep());
  const numbered = deltas.map((delta) => replay.record(delta));
  expect(replay.replay(threadId)).toEqual([
    {
      chunk: {
        omittedBytes: bytes(deltas[0] as HostRunTelemetry),
        resumesAt: 1,
        type: TOOL_TELEMETRY_OMITTED_TYPE,
      },
      runId,
      threadId,
    },
    numbered[1],
    numbered[2],
  ]);
});
