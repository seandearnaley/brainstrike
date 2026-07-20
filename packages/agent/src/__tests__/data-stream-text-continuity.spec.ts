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
import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '../index';
import { AssistantDataStreamSession } from '../stream/data-stream';

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
