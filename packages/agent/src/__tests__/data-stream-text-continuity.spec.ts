/**
 * Text continuity + parallel tool-call mapping for the data-stream session.
 *
 * Run-event data parts ('aui-data') close the active text/reasoning append in
 * assistant-stream's accumulator, so any event emitted mid-text slices the
 * visible response into fragments. The mapper must defer run events that
 * arrive while a text/reasoning part is streaming and flush them at the next
 * boundary (tool start, finish). Parallel tool calls (Mastra executes up to
 * 10 concurrently) must map interleaved per-call chunks without cross-talk.
 */
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '..';
import { AssistantDataStreamSession } from '../stream/data-stream';
import { DataStreamMapper } from '../stream/data-stream-mapper';

interface Encoded {
  code: string;
  value: unknown;
}

function createAsyncStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

async function readResponse(response: Response): Promise<string[]> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) {
    return [];
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value && value.length > 0) {
      buffer += decoder.decode(value, { stream: true });
    }
  }
  buffer += decoder.decode();
  return buffer
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseLines(lines: string[]): Encoded[] {
  return lines.map((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error(`invalid data stream line: ${line}`);
    }
    return { code: line.slice(0, idx), value: JSON.parse(line.slice(idx + 1)) } satisfies Encoded;
  });
}

function runEventChunk(id: string, label: string): StreamChunk {
  return {
    event: {
      id,
      kind: 'memory.working.loaded',
      label,
      status: 'info',
      timestamp: '2026-06-12T00:00:00.000Z',
    },
    type: 'run-event',
  } as unknown as StreamChunk;
}

function subagentRunEventChunk(
  id: string,
  kind: string,
  status: string,
  label: string,
  metadata: Record<string, unknown> = {}
): StreamChunk {
  return {
    event: {
      id,
      kind,
      label,
      metadata,
      status,
      timestamp: '2026-06-12T00:00:00.000Z',
    },
    type: 'run-event',
  } as unknown as StreamChunk;
}

async function mapChunks(chunks: StreamChunk[]): Promise<Encoded[]> {
  const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
    messageId: 'msg-text-continuity',
    sessionId: 'text-continuity-test',
  });
  return parseLines(await readResponse(session.createResponse()));
}

describe('unknown stream-chunk diagnostics', () => {
  it('warns and keeps the data stream open when a runtime chunk is unrecognized', () => {
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));

    try {
      const mapper = new DataStreamMapper('msg-unknown-chunk');
      expect([
        ...mapper.handleChunk({ type: 'future-brainstrike-stream-chunk' } as StreamChunk),
      ]).toEqual([]);
      expect([
        ...mapper.handleChunk({ type: 'future-brainstrike-stream-chunk' } as StreamChunk),
      ]).toEqual([]);
    } finally {
      removeLogListener();
    }

    const diagnosticRecords = logRecords.filter((record) =>
      record.args.some(
        (arg) =>
          Boolean(arg && typeof arg === 'object') &&
          (arg as { code?: unknown }).code === 'data_stream_mapper_unrecognized_chunk'
      )
    );
    const diagnosticFields = diagnosticRecords[0]?.args.find(
      (arg): arg is Record<string, unknown> =>
        Boolean(arg && typeof arg === 'object') &&
        (arg as { code?: unknown }).code === 'data_stream_mapper_unrecognized_chunk'
    );
    expect(diagnosticRecords).toHaveLength(1);
    expect(diagnosticRecords[0]?.level).toBe(LogLevel.WARN);
    expect(diagnosticFields).toMatchObject({
      chunkType: 'future-brainstrike-stream-chunk',
      code: 'data_stream_mapper_unrecognized_chunk',
    });
  });
});

const finishChunk: StreamChunk = {
  type: 'finish',
  usage: { completionTokens: 1, promptTokens: 1 },
} as unknown as StreamChunk;

describe('run-event deferral keeps streamed text contiguous', () => {
  it('never emits an aui-data part between text deltas of one block', async () => {
    const parsed = await mapChunks([
      { type: 'text-delta', value: 'Hello ' } as StreamChunk,
      runEventChunk('ev-1', 'Observational memory read'),
      { type: 'text-delta', value: 'world.' } as StreamChunk,
      runEventChunk('ev-2', 'Working memory loaded'),
      finishChunk,
    ]);

    const codes = parsed.map((p) => p.code);
    const firstText = codes.indexOf('0');
    const lastText = codes.lastIndexOf('0');
    const dataIndices = codes.flatMap((code, i) => (code === 'aui-data' ? [i] : []));

    expect(dataIndices).toHaveLength(2);
    for (const dataIndex of dataIndices) {
      expect(dataIndex > lastText || dataIndex < firstText).toBe(true);
    }
    // Both deferred events are still delivered before the message finishes.
    const finishIndex = codes.indexOf('d');
    for (const dataIndex of dataIndices) {
      expect(dataIndex).toBeLessThan(finishIndex);
    }
  });

  it('flushes deferred run events before a tool call starts', async () => {
    const parsed = await mapChunks([
      { type: 'text-delta', value: 'Searching now.' } as StreamChunk,
      runEventChunk('ev-1', 'Observation'),
      {
        name: 'brainstrike.grepSearch',
        payload: { input: { pattern: 'x' }, toolCallId: 'call-1' },
        status: 'start',
        type: 'tool-event',
      } as unknown as StreamChunk,
      {
        name: 'brainstrike.grepSearch',
        payload: { output: { files: [] }, toolCallId: 'call-1' },
        status: 'success',
        type: 'tool-event',
      } as unknown as StreamChunk,
      finishChunk,
    ]);

    const codes = parsed.map((p) => p.code);
    const dataIndex = codes.indexOf('aui-data');
    const toolStartIndex = codes.indexOf('b');
    expect(dataIndex).toBeGreaterThan(codes.lastIndexOf('0'));
    expect(dataIndex).toBeLessThan(toolStartIndex);
  });

  it('emits run events immediately when no text is streaming', async () => {
    const parsed = await mapChunks([
      runEventChunk('ev-1', 'Run started'),
      { type: 'text-delta', value: 'Answer.' } as StreamChunk,
      finishChunk,
    ]);

    const codes = parsed.map((p) => p.code);
    expect(codes.indexOf('aui-data')).toBeLessThan(codes.indexOf('0'));
  });

  it('defers a subagent.* run event that arrives mid-text and flushes it at the next boundary', async () => {
    const parsed = await mapChunks([
      { type: 'text-delta', value: 'Delegating ' } as StreamChunk,
      // A nested subagent tool event arrives WHILE the parent text is streaming.
      subagentRunEventChunk('sub-1', 'subagent.tool.started', 'running', 'Subagent tool started', {
        parentToolCallId: 'delegation-1',
        personaId: 'explore',
      }),
      { type: 'text-delta', value: 'to the explorer.' } as StreamChunk,
      finishChunk,
    ]);

    const codes = parsed.map((p) => p.code);
    const firstText = codes.indexOf('0');
    const lastText = codes.lastIndexOf('0');
    const dataIndices = codes.flatMap((code, i) => (code === 'aui-data' ? [i] : []));
    // The subagent event never slices the text block: it lands after the last
    // text delta (flushed at the finish boundary), not between the two deltas.
    expect(dataIndices).toHaveLength(1);
    expect(dataIndices[0]).toBeGreaterThan(lastText);
    expect(dataIndices[0]).toBeLessThan(codes.indexOf('d'));
    // Sanity: the two text deltas remained contiguous.
    expect(lastText - firstText).toBe(1);
  });

  it('surfaces subagent.failed and subagent.tool.failed through the mapper failure branches', async () => {
    const parsed = await mapChunks([
      subagentRunEventChunk('sub-tf', 'subagent.tool.failed', 'failed', 'Subagent tool failed', {
        childToolName: 'brainstrike_grepSearch',
        parentToolCallId: 'delegation-1',
        personaId: 'explore',
        toolCallId: 'child-1',
      }),
      subagentRunEventChunk('sub-f', 'subagent.failed', 'failed', 'Subagent failed', {
        parentToolCallId: 'delegation-1',
        personaId: 'explore',
      }),
      finishChunk,
    ]);

    const failureEvents = parsed
      .filter((p) => p.code === 'aui-data')
      .map((p) => p.value as { name?: string; data?: { kind?: string; status?: string } })
      .filter((part) => part.name === 'brainstrike.run-event')
      .map((part) => part.data);

    expect(failureEvents).toEqual(
      [
        { kind: 'subagent.tool.failed', status: 'failed' },
        { kind: 'subagent.failed', status: 'failed' },
      ].map((expected) => expect.objectContaining(expected))
    );
  });
});

describe('context-breakdown data part respects text continuity', () => {
  const breakdownChunk: StreamChunk = {
    breakdown: {
      attachmentsCount: 0,
      historyMessagesTokens: 250,
      provenance: 'heuristic',
      systemInstructionsTokens: 1200,
      taskListTokens: 40,
    },
    type: 'context-breakdown',
  } as unknown as StreamChunk;

  it('emits the run-start breakdown immediately, before any streamed text', async () => {
    const parsed = await mapChunks([
      breakdownChunk,
      { type: 'text-delta', value: 'Answer.' } as StreamChunk,
      finishChunk,
    ]);

    const codes = parsed.map((p) => p.code);
    const dataIndex = codes.indexOf('aui-data');
    expect(dataIndex).toBeGreaterThanOrEqual(0);
    expect(dataIndex).toBeLessThan(codes.indexOf('0'));
    const part = parsed[dataIndex]?.value as { name?: string; data?: Record<string, unknown> };
    expect(part.name).toBe('brainstrike.context-breakdown');
    // NOT the run-event data name: run-events are persisted server-side, and
    // the breakdown must stay transient (shell-output precedent).
    expect(part.name).not.toBe('brainstrike.run-event');
    expect(part.data).toEqual({
      attachmentsCount: 0,
      historyMessagesTokens: 250,
      provenance: 'heuristic',
      systemInstructionsTokens: 1200,
      taskListTokens: 40,
    });
  });

  it('defers a breakdown that arrives mid-text and flushes it at the next boundary', async () => {
    const parsed = await mapChunks([
      { type: 'text-delta', value: 'Hello ' } as StreamChunk,
      breakdownChunk,
      { type: 'text-delta', value: 'world.' } as StreamChunk,
      finishChunk,
    ]);

    const codes = parsed.map((p) => p.code);
    const firstText = codes.indexOf('0');
    const lastText = codes.lastIndexOf('0');
    const dataIndices = codes.flatMap((code, i) => (code === 'aui-data' ? [i] : []));
    expect(dataIndices).toHaveLength(1);
    // Never sliced into the text block; still delivered before the finish.
    expect(dataIndices[0]).toBeGreaterThan(lastText);
    expect(dataIndices[0]).toBeLessThan(codes.indexOf('d'));
    expect(lastText - firstText).toBe(1);
  });
});

describe('tool-suspend-required data part respects text continuity', () => {
  it('finalizes open text before emitting exactly one brainstrike.tool-suspend data part', async () => {
    const parsed = await mapChunks([
      { type: 'text-delta', value: 'Let me ask you.' } as StreamChunk,
      runEventChunk('ev-1', 'Observation'),
      {
        runId: 'run-1',
        suspendPayload: { question: 'Which city?' },
        toolCallId: 'call-suspend-1',
        toolName: 'brainstrike.askUser',
        type: 'tool-suspend-required',
      } as unknown as StreamChunk,
      finishChunk,
    ]);

    const codes = parsed.map((p) => p.code);
    const dataParts = parsed.filter(
      (p) =>
        p.code === 'aui-data' && (p.value as { name?: string }).name === 'brainstrike.tool-suspend'
    );
    // Exactly one suspend data part, carrying the pause payload.
    expect(dataParts).toHaveLength(1);
    expect(
      (dataParts[0]?.value as { data: Record<string, unknown> } | undefined)?.data
    ).toMatchObject({
      runId: 'run-1',
      suspendPayload: { question: 'Which city?' },
      toolCallId: 'call-suspend-1',
      toolName: 'brainstrike.askUser',
    });
    // Text-part-closed-before-data-part: the open text is FULLY finalized before
    // ANY data part is emitted. Pinning only the LAST data part would still pass
    // if an earlier data part sliced mid-text, so assert the FIRST data part
    // (the flushed run event) already lands after the last text delta — no data
    // part may appear before the text block is closed.
    const lastTextIndex = codes.lastIndexOf('0');
    expect(codes.indexOf('aui-data')).toBeGreaterThan(lastTextIndex);
    const suspendDataIndex = codes.lastIndexOf('aui-data');
    expect(suspendDataIndex).toBeGreaterThan(lastTextIndex);
  });
});

function toolStartChunk(name: string, callId: string, input?: unknown): StreamChunk {
  return {
    name,
    payload: { input, toolCallId: callId },
    status: 'start',
    type: 'tool-event',
  } as unknown as StreamChunk;
}

function argsDeltaChunk(name: string, callId: string, delta: string): StreamChunk {
  return {
    name,
    payload: { argsTextDelta: delta, step: 'input_stream_delta', toolCallId: callId },
    status: 'progress',
    type: 'tool-event',
  } as unknown as StreamChunk;
}

function argsEndChunk(name: string, callId: string): StreamChunk {
  return {
    name,
    payload: { step: 'input_stream_end', toolCallId: callId },
    status: 'progress',
    type: 'tool-event',
  } as unknown as StreamChunk;
}

function toolSuccessChunk(name: string, callId: string, output: unknown): StreamChunk {
  return {
    name,
    payload: { output, toolCallId: callId },
    status: 'success',
    type: 'tool-event',
  } as unknown as StreamChunk;
}

/**
 * Renderer-decoder safety invariant (BST-962).
 *
 * ORIGIN (assistant-stream 0.3.25 through 0.3.34): the DataStreamDecoder closed
 * the ACTIVE tool call's argsText controller on every frame in its
 * TOOL_CALL_ARGS_CLOSING_CHUNKS set — `b`, `9`, `0`, `g`, `h`, `3`, `e`, `d`,
 * `aui-text-delta`, `aui-reasoning-delta`, `aui-data` — so any such frame
 * between a call's `b` and its `9` made the next `c` append to a closed
 * controller: an unhandled "Cannot enqueue a chunk into a readable stream that
 * is closed" TypeError that killed the whole renderer pipeline while the
 * agent-side run completed invisibly.
 *
 * NOW (pinned 0.3.37): that set was REMOVED in 0.3.35 and does not exist in the
 * installed dist. An argsText closes only on an explicit frame — the complete
 * `9`, a `c` carrying `isFinal`, the `a` result, or the stream-wide close that
 * `3`/`e`/`d` and flush run — and a late `c` is dropped behind a `console.warn`
 * rather than throwing.
 *
 * This sweep is therefore KEPT DELIBERATELY, and is now stricter than the
 * pinned decoder requires. Two reasons it is not dead weight: the ordering it
 * asserts is valid against both the pre- and post-0.3.35 decoders, and the
 * failure it prevents got QUIETER rather than smaller — silently dropped args
 * are still a correctness bug, now without a visible crash to report them.
 * Relaxing it is a real question but needs its own ticket and evidence; do not
 * weaken it as a side effect of a dependency bump.
 *
 * See docs/agents/assistant-runtime.md (BST-962 paragraph) for the full
 * decoder-behaviour contract this mirrors.
 */
function expectDecoderSafeArgsStream(parsed: Encoded[]): void {
  const closingCodes = new Set(['b', '9', '0', 'g', 'h', '3', 'e', 'd', 'aui-data']);
  let openArgsCallId: string | null = null;
  for (const frame of parsed) {
    const frameCallId = (frame.value as { toolCallId?: string } | null)?.toolCallId;
    if (frame.code === 'b') {
      expect(openArgsCallId).toBeNull();
      openArgsCallId = frameCallId ?? null;
      continue;
    }
    if (frame.code === '9') {
      if (openArgsCallId !== null) {
        expect(frameCallId).toBe(openArgsCallId);
        openArgsCallId = null;
      }
      continue;
    }
    if (openArgsCallId !== null && closingCodes.has(frame.code)) {
      throw new Error(
        `decoder-unsafe frame '${frame.code}' inside the open args stream of ${openArgsCallId}`
      );
    }
  }
}

describe('aui-data parts never interleave into an open tool-call args stream (BST-962)', () => {
  it('defers a run event that arrives mid-args and flushes it after the args-complete frame', async () => {
    const parsed = await mapChunks([
      toolStartChunk('updateWorkingMemory', 'call-om'),
      argsDeltaChunk('updateWorkingMemory', 'call-om', '{"memory":'),
      // The OM observer finishes a buffered-observation cycle mid-args — the
      // BST-962 incident interleave.
      runEventChunk('ev-om', 'Buffered observations updated'),
      argsDeltaChunk('updateWorkingMemory', 'call-om', '"# User Information"}'),
      argsEndChunk('updateWorkingMemory', 'call-om'),
      toolSuccessChunk('updateWorkingMemory', 'call-om', { success: true }),
      finishChunk,
    ]);

    expectDecoderSafeArgsStream(parsed);
    const codes = parsed.map((p) => p.code);
    const dataIndex = codes.indexOf('aui-data');
    const argsCompleteIndex = codes.indexOf('9');
    const resultIndex = codes.indexOf('a');
    // Deferred past the open args stream, but not lost and not late: the run
    // event lands at the next boundary (the `9`), before the tool result.
    expect(dataIndex).toBeGreaterThan(argsCompleteIndex);
    expect(dataIndex).toBeLessThan(resultIndex);
    // Both deltas survived deferral — the assembled args are complete.
    const argsFrame = parsed[argsCompleteIndex]?.value as { args: Record<string, unknown> };
    expect(argsFrame.args).toEqual({ memory: '# User Information' });
  });

  it('defers breakdown, child-run-usage, and shell-output data parts that arrive mid-args', async () => {
    const parsed = await mapChunks([
      toolStartChunk('brainstrike.grepSearch', 'call-1'),
      argsDeltaChunk('brainstrike.grepSearch', 'call-1', '{"pattern":'),
      {
        breakdown: { historyMessagesTokens: 1, provenance: 'heuristic' },
        type: 'context-breakdown',
      } as unknown as StreamChunk,
      {
        type: 'child-run-usage',
        value: { inputTokens: 10, outputTokens: 5, source: 'observation' },
      } as unknown as StreamChunk,
      {
        chunk: 'compiling...',
        stream: 'stdout',
        toolCallId: 'call-1',
        type: 'shell-output',
      } as unknown as StreamChunk,
      argsDeltaChunk('brainstrike.grepSearch', 'call-1', '"x"}'),
      argsEndChunk('brainstrike.grepSearch', 'call-1'),
      toolSuccessChunk('brainstrike.grepSearch', 'call-1', { files: [] }),
      finishChunk,
    ]);

    expectDecoderSafeArgsStream(parsed);
    const codes = parsed.map((p) => p.code);
    const dataIndices = codes.flatMap((code, i) => (code === 'aui-data' ? [i] : []));
    expect(dataIndices).toHaveLength(3);
    const argsCompleteIndex = codes.indexOf('9');
    for (const dataIndex of dataIndices) {
      expect(dataIndex).toBeGreaterThan(argsCompleteIndex);
      expect(dataIndex).toBeLessThan(codes.indexOf('d'));
    }
  });

  it('closes an open args stream before streaming text or reasoning deltas', async () => {
    const parsed = await mapChunks([
      toolStartChunk('brainstrike.grepSearch', 'call-1'),
      argsDeltaChunk('brainstrike.grepSearch', 'call-1', '{"pattern":"x"}'),
      // Defensive: the model moved on to visible text without an
      // input_stream_end. The mapper must still emit the args-complete `9`
      // first, so the args are complete before any later frame closes the
      // controller (`0`/`g` themselves stopped closing it at 0.3.35).
      { type: 'text-delta', value: 'Now searching.' } as StreamChunk,
      { type: 'reasoning-delta', value: 'thinking' } as StreamChunk,
      toolSuccessChunk('brainstrike.grepSearch', 'call-1', { files: [] }),
      finishChunk,
    ]);

    expectDecoderSafeArgsStream(parsed);
    const codes = parsed.map((p) => p.code);
    const argsCompleteIndex = codes.indexOf('9');
    expect(argsCompleteIndex).toBeGreaterThan(-1);
    expect(argsCompleteIndex).toBeLessThan(codes.indexOf('0'));
    const argsFrame = parsed[argsCompleteIndex]?.value as { args: Record<string, unknown> };
    expect(argsFrame.args).toEqual({ pattern: 'x' });
  });

  it('emits the args-complete frame before any aui-data when a suspend pauses mid-args', async () => {
    const parsed = await mapChunks([
      toolStartChunk('brainstrike.submitPlan', 'call-plan'),
      argsDeltaChunk('brainstrike.submitPlan', 'call-plan', '{"title":"Plan"}'),
      runEventChunk('ev-1', 'Buffered observations updated'),
      {
        runId: 'run-1',
        suspendPayload: { title: 'Plan' },
        toolCallId: 'call-plan',
        toolName: 'brainstrike.submitPlan',
        type: 'tool-suspend-required',
      } as unknown as StreamChunk,
      finishChunk,
    ]);

    expectDecoderSafeArgsStream(parsed);
    const codes = parsed.map((p) => p.code);
    const firstDataIndex = codes.indexOf('aui-data');
    expect(codes.indexOf('9')).toBeLessThan(firstDataIndex);
    // The deferred run event still flows, before the suspend notice.
    const names = parsed
      .filter((p) => p.code === 'aui-data')
      .map((p) => (p.value as { name?: string }).name);
    expect(names.indexOf('brainstrike.run-event')).toBeLessThan(
      names.indexOf('brainstrike.tool-suspend')
    );
  });

  it('emits the args-complete frame before any aui-data when an approval pauses mid-args', async () => {
    const parsed = await mapChunks([
      toolStartChunk('brainstrike.executeCommand', 'call-cmd'),
      argsDeltaChunk('brainstrike.executeCommand', 'call-cmd', '{"command":"ls"}'),
      runEventChunk('ev-1', 'Observation'),
      {
        args: { command: 'ls' },
        runId: 'run-1',
        toolCallId: 'call-cmd',
        toolName: 'brainstrike.executeCommand',
        type: 'tool-approval-required',
      } as unknown as StreamChunk,
      finishChunk,
    ]);

    expectDecoderSafeArgsStream(parsed);
    const codes = parsed.map((p) => p.code);
    expect(codes.indexOf('9')).toBeLessThan(codes.indexOf('aui-data'));
  });

  it('drops a late input_stream_end after a forced close instead of re-emitting the args frame', async () => {
    const parsed = await mapChunks([
      toolStartChunk('brainstrike.grepSearch', 'call-1'),
      argsDeltaChunk('brainstrike.grepSearch', 'call-1', '{"pattern":'),
      // Text force-closes the args stream (its `9` is emitted with the args
      // accumulated so far); the provider's own late input_stream_end must
      // then be dropped — a second `9` re-closes an already-closed argsText,
      // the same class the settled-id rule guards against.
      { type: 'text-delta', value: 'Searching.' } as StreamChunk,
      argsEndChunk('brainstrike.grepSearch', 'call-1'),
      toolSuccessChunk('brainstrike.grepSearch', 'call-1', { files: [] }),
      finishChunk,
    ]);

    expectDecoderSafeArgsStream(parsed);
    const argsFrames = parsed.filter((p) => p.code === '9');
    expect(argsFrames).toHaveLength(1);
  });

  it('keeps deferred data parts out of an open text block after a forced args closure', async () => {
    const parsed = await mapChunks([
      toolStartChunk('brainstrike.grepSearch', 'call-1'),
      argsDeltaChunk('brainstrike.grepSearch', 'call-1', '{"pattern":"x"}'),
      { type: 'text-delta', value: 'Hello ' } as StreamChunk,
      // Deferred while the text block streams…
      runEventChunk('ev-1', 'Observation'),
      // …and the provider's late input_stream_end must NOT flush it mid-text
      // (nor re-emit the `9`).
      argsEndChunk('brainstrike.grepSearch', 'call-1'),
      { type: 'text-delta', value: 'world.' } as StreamChunk,
      finishChunk,
    ]);

    expectDecoderSafeArgsStream(parsed);
    const codes = parsed.map((p) => p.code);
    expect(parsed.filter((p) => p.code === '9')).toHaveLength(1);
    const firstText = codes.indexOf('0');
    const lastText = codes.lastIndexOf('0');
    expect(lastText - firstText).toBe(1);
    const dataIndex = codes.indexOf('aui-data');
    // Still delivered, but only after the text block closes.
    expect(dataIndex).toBeGreaterThan(lastText);
    expect(dataIndex).toBeLessThan(codes.indexOf('d'));
  });

  it('streams execution-time data parts live when the start already carries complete args', async () => {
    // Non-streaming provider path: a `tool-call` part maps to a start event
    // with the full input and no input_stream_* events ever follow. The args
    // window must close at the start (`b`, complete input `c`, then `9`), not at
    // settlement — otherwise live shell output and run events produced DURING
    // execution are buffered until the result.
    const parsed = await mapChunks([
      toolStartChunk('brainstrike.executeCommand', 'call-sh', { command: 'pnpm build' }),
      {
        chunk: 'compiling...',
        stream: 'stdout',
        toolCallId: 'call-sh',
        type: 'shell-output',
      } as unknown as StreamChunk,
      runEventChunk('ev-exec', 'Working memory loaded'),
      {
        chunk: 'done.',
        stream: 'stdout',
        toolCallId: 'call-sh',
        type: 'shell-output',
      } as unknown as StreamChunk,
      toolSuccessChunk('brainstrike.executeCommand', 'call-sh', { exitCode: 0 }),
      finishChunk,
    ]);

    expectDecoderSafeArgsStream(parsed);
    const codes = parsed.map((p) => p.code);
    expect(codes.slice(codes.indexOf('b'), codes.indexOf('9') + 1)).toEqual(['b', 'c', '9']);
    const resultIndex = codes.indexOf('a');
    const dataIndices = codes.flatMap((code, i) => (code === 'aui-data' ? [i] : []));
    expect(dataIndices).toHaveLength(3);
    // All three data parts stream during execution, before the tool result.
    for (const dataIndex of dataIndices) {
      expect(dataIndex).toBeLessThan(resultIndex);
    }
    const argsFrame = parsed[codes.indexOf('9')]?.value as { args: Record<string, unknown> };
    expect(argsFrame.args).toEqual({ command: 'pnpm build' });
  });

  it('closes an open args stream before the finish frames when the stream ends mid-args', async () => {
    const parsed = await mapChunks([
      toolStartChunk('brainstrike.grepSearch', 'call-1'),
      argsDeltaChunk('brainstrike.grepSearch', 'call-1', '{"pattern":"x"}'),
      runEventChunk('ev-1', 'Observation'),
      finishChunk,
    ]);

    expectDecoderSafeArgsStream(parsed);
    const codes = parsed.map((p) => p.code);
    // `e`/`d` still close the args stream at 0.3.37 (and `aui-data` did through
    // 0.3.34): the `9` must come first so the args land complete.
    expect(codes.indexOf('9')).toBeLessThan(codes.indexOf('aui-data'));
    expect(codes.indexOf('9')).toBeLessThan(codes.indexOf('d'));
  });
});

describe('parallel tool calls map interleaved chunks without cross-talk', () => {
  it('keeps two concurrent tool calls separate through start/args/result interleaving', async () => {
    const parsed = await mapChunks([
      {
        name: 'brainstrike.grepSearch',
        payload: { input: undefined, toolCallId: 'call-a' },
        status: 'start',
        type: 'tool-event',
      } as unknown as StreamChunk,
      {
        name: 'brainstrike.readWorkspaceDirectory',
        payload: { input: undefined, toolCallId: 'call-b' },
        status: 'start',
        type: 'tool-event',
      } as unknown as StreamChunk,
      {
        name: 'brainstrike.grepSearch',
        payload: {
          argsTextDelta: '{"pattern":"a"}',
          step: 'input_stream_delta',
          toolCallId: 'call-a',
        },
        status: 'progress',
        type: 'tool-event',
      } as unknown as StreamChunk,
      {
        name: 'brainstrike.readWorkspaceDirectory',
        payload: {
          argsTextDelta: '{"path":"/b"}',
          step: 'input_stream_delta',
          toolCallId: 'call-b',
        },
        status: 'progress',
        type: 'tool-event',
      } as unknown as StreamChunk,
      // Results complete out of order (b finishes first).
      {
        name: 'brainstrike.readWorkspaceDirectory',
        payload: { output: { count: 0, entries: [] }, toolCallId: 'call-b' },
        status: 'success',
        type: 'tool-event',
      } as unknown as StreamChunk,
      {
        name: 'brainstrike.grepSearch',
        payload: { output: { files: [], totalFiles: 0 }, toolCallId: 'call-a' },
        status: 'success',
        type: 'tool-event',
      } as unknown as StreamChunk,
      finishChunk,
    ]);

    const toolCalls = parsed.filter((p) => p.code === '9') as Array<{
      code: string;
      value: { toolCallId: string; toolName: string; args: Record<string, unknown> };
    }>;
    const results = parsed.filter((p) => p.code === 'a') as Array<{
      code: string;
      value: { toolCallId: string; isError?: boolean };
    }>;

    expect(toolCalls.map((c) => c.value.toolCallId).sort()).toEqual(['call-a', 'call-b']);
    const callA = toolCalls.find((c) => c.value.toolCallId === 'call-a');
    const callB = toolCalls.find((c) => c.value.toolCallId === 'call-b');
    expect(callA?.value.toolName).toBe('brainstrike.grepSearch');
    expect(callA?.value.args).toEqual({ pattern: 'a' });
    expect(callB?.value.toolName).toBe('brainstrike.readWorkspaceDirectory');
    expect(callB?.value.args).toEqual({ path: '/b' });

    expect(results.map((r) => r.value.toolCallId)).toEqual(['call-b', 'call-a']);
    expect(results.every((r) => r.value.isError !== true)).toBe(true);
  });
});
