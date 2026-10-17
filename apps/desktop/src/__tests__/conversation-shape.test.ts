// @vitest-environment node
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { describe, expect, it } from 'vitest';
import { committedConversation } from '../../e2e/utils/conversation-invariants';
import { conversationShape, renderedSteps } from './helpers/conversation-shape';

const THREAD = 'thread-1';

/** Committed rows in order, numbered from seq 1, in the shapes a real host commits. */
function log(...events: readonly Record<string, unknown>[]): HostLogRow[] {
  return events.map((event, index) => ({
    event: event as HostLogRow['event'],
    seq: index + 1,
    threadId: THREAD,
  }));
}

const chunk = (runId: string, value: Record<string, unknown>) => ({
  chunk: value,
  runId,
  type: 'stream.chunk',
});
const started = (runId: string) => ({
  modelId: 'openai::gpt-5.4-mini',
  prompt: 'Go.',
  runId,
  type: 'run.started',
});
const finished = (runId: string, outcome = 'completed') => ({
  outcome,
  runId,
  type: 'run.finished',
});
const title = { title: 'A title', type: 'thread.updated' };
const step = (runId: string, ...content: readonly Record<string, unknown>[]) =>
  toolStep(runId, [], ...content);
/** A step as committed: its start, the chunks it streamed, its `model.step`, its finish. */
const toolStep = (
  runId: string,
  streamed: readonly Record<string, unknown>[],
  ...content: readonly Record<string, unknown>[]
) => [
  chunk(runId, { request: {}, type: 'start-step', warnings: [] }),
  ...streamed,
  {
    messages: [{ content, role: 'assistant' }],
    model: { modelId: 'm', provider: 'p' },
    runId,
    stepNumber: 0,
    type: 'model.step',
    usage: {},
  },
  chunk(runId, { finishReason: 'stop', type: 'finish-step' }),
];
const text = (value: string) => ({ text: value, type: 'text' });
const call = (runId: string, id: string, output?: unknown) => [
  chunk(runId, { id, toolName: 'brainstrike_readWorkspaceFile', type: 'tool-input-start' }),
  chunk(runId, { delta: '{"path":"a.md"}', id, type: 'tool-input-delta' }),
  chunk(runId, { id, type: 'tool-input-end' }),
  chunk(runId, {
    input: { path: 'a.md' },
    toolCallId: id,
    toolName: 'brainstrike_readWorkspaceFile',
    type: 'tool-call',
  }),
  ...(output === undefined
    ? []
    : [
        chunk(runId, {
          input: { path: 'a.md' },
          output,
          toolCallId: id,
          toolName: 'brainstrike_readWorkspaceFile',
          type: 'tool-result',
        }),
      ]),
];

function shapeOf(
  rows: readonly HostLogRow[],
  children: readonly { rows: HostLogRow[]; threadId: string }[] = []
) {
  return conversationShape({ children, parent: { rows, threadId: THREAD } });
}

const invariants = (result: { violations: readonly { invariant: string }[] }) =>
  result.violations.map(({ invariant }) => invariant);

describe('conversation shape', () => {
  it('names groups, rows, paragraphs per step and title timing, never text', () => {
    const rows = log(
      started('r1'),
      title,
      ...toolStep('r1', call('r1', 'c1', { content: '1: a' }), {
        input: { path: 'a.md' },
        toolCallId: 'c1',
        toolName: 'brainstrike_readWorkspaceFile',
        type: 'tool-call',
      }),
      ...step('r1', text('First, '), text('then done.')),
      finished('r1')
    );
    const result = shapeOf(rows);
    expect(result.violations).toEqual([]);
    expect(result.shape).toEqual({
      children: [],
      projection: 'folded',
      runs: [
        {
          groups: ['activity×1', 'text', 'notice:run.finished'],
          message: 'complete:stop',
          outcome: 'completed',
          rows: ['Read done'],
          steps: [
            { calls: 1, paragraphs: 0, reasoning: 0 },
            { calls: 0, paragraphs: 1, reasoning: 0 },
          ],
        },
      ],
      title: 'before-first-run-finished',
    });
    expect(JSON.stringify(result.shape)).not.toContain('done.');
  });

  it('reports a title committed only after the first completed run finished (#3720)', () => {
    const late = log(started('r1'), ...step('r1', text('Hi.')), finished('r1'), title);
    expect(invariants(shapeOf(late))).toEqual(['title-before-first-run-finished']);
    expect(shapeOf(late).shape.title).toBe('after-first-run-finished');
    const untitled = log(started('r1'), ...step('r1', text('Hi.')), finished('r1'));
    expect(invariants(shapeOf(untitled))).toEqual(['title-before-first-run-finished']);
    // A failed first run commits no title, and that is no violation.
    const failed = log(started('r1'), finished('r1', 'failed'));
    expect(invariants(shapeOf(failed))).toEqual([]);
  });

  it('reports a row the projection cannot read, and nothing it would have derived past it (#3713)', () => {
    const rows = log(
      started('r1'),
      title,
      chunk('r1', { request: {}, type: 'start-step', warnings: [] }),
      chunk('r1', { toolName: 'brainstrike_readWorkspaceFile', type: 'tool-input-start' }),
      finished('r1')
    );
    const result = shapeOf(rows);
    expect(invariants(result)).toEqual(['projection-folds']);
    expect(result.shape.projection).toMatch(/^failed at seq 4 stream\.chunk: /u);
  });

  it('reports a completed run whose call never settled, but not a stopped one', () => {
    const open = log(started('r1'), title, ...call('r1', 'c1'), finished('r1'));
    expect(invariants(shapeOf(open))).toContain('tool-rows-terminal-after-finish');
    const stopped = log(started('r1'), title, ...call('r1', 'c1'), finished('r1', 'stopped'));
    expect(invariants(shapeOf(stopped))).toEqual([]);
  });

  it('reports rows after run.finished and a run that never finished', () => {
    const late = log(
      started('r1'),
      title,
      ...step('r1', text('Hi.')),
      finished('r1'),
      chunk('r1', { type: 'finish' })
    );
    expect(invariants(shapeOf(late))).toContain('nothing-running-after-finish');
    const unfinished = log(started('r1'), title, chunk('r1', { type: 'start' }));
    expect(invariants(shapeOf(unfinished))).toContain('nothing-running-after-finish');
  });

  it("reports a tool result hidden behind the guard's generic fault, not a typed refusal (#3727)", () => {
    const fault = { error: { code: 'tool_failed', message: 'x', toolName: 'grep' }, ok: false };
    const refusal = {
      error: { code: 'tool_input_invalid', message: 'x', toolName: 'grep' },
      ok: false,
    };
    const rowsWith = (output: unknown) =>
      log(
        started('r1'),
        title,
        ...call('r1', 'c1', output),
        ...step('r1', text('Hi.')),
        finished('r1')
      );
    expect(invariants(shapeOf(rowsWith(fault)))).toEqual(['typed-refusal-reaches-tool-result']);
    expect(invariants(shapeOf(rowsWith(refusal)))).toEqual([]);
  });
});

describe('committed delegation cards (#3719)', () => {
  const child = {
    rows: log(
      started('k1'),
      ...call('k1', 'k-c1', { ok: true }),
      ...call('k1', 'k-c2', { ok: true }),
      finished('k1')
    ),
    threadId: 'child-1',
  };
  const parent = {
    rows: log(started('r1'), title, ...step('r1', text('Hi.')), finished('r1')),
    threadId: THREAD,
  };

  it("reports a card whose count is not its child's ledger", () => {
    const stale = committedConversation({
      cards: [{ childThreadId: 'child-1', state: 'Explorer finished', toolCalls: 0 }],
      children: [child],
      parent,
    });
    expect(stale.violations).toEqual([
      expect.objectContaining({ invariant: 'card-count-equals-child-ledger' }),
    ]);
    expect(stale.shape.children).toEqual([{ outcome: 'completed', toolCalls: 2 }]);
    const unread = committedConversation({
      cards: [{ childThreadId: 'child-1', state: 'Explorer is working', toolCalls: null }],
      children: [child],
      parent,
    });
    expect(unread.violations).toHaveLength(1);
  });

  it('accepts a card that counts its child exactly, and refuses a card for an unknown child', () => {
    expect(
      committedConversation({
        cards: [{ childThreadId: 'child-1', state: 'Explorer finished', toolCalls: 2 }],
        children: [child],
        parent,
      }).violations
    ).toEqual([]);
    expect(
      committedConversation({
        cards: [{ childThreadId: 'nobody', state: 'Explorer finished', toolCalls: 2 }],
        children: [child],
        parent,
      }).violations
    ).toEqual([expect.objectContaining({ invariant: 'card-count-equals-child-ledger' })]);
  });
});

describe('rendered steps (#3725)', () => {
  const stepStart = { data: { type: 'start-step' }, name: 'brainstrike.host-stream', type: 'data' };
  const message = (...content: readonly Record<string, unknown>[]) =>
    ({
      content,
      id: 'r1',
      role: 'assistant',
      status: { type: 'complete' },
    }) as unknown as Parameters<typeof renderedSteps>[0];
  const part = { text: 'a', type: 'text' };

  it('finds two text parts drawn next to each other in one step', () => {
    expect(renderedSteps(message(stepStart, part, part)).adjacent).toEqual([1]);
    expect(
      renderedSteps(message(stepStart, part, { text: '', type: 'reasoning' }, part)).adjacent
    ).toEqual([1]);
    expect(renderedSteps(message(stepStart, part, part)).steps).toEqual([
      { calls: 0, paragraphs: 2, reasoning: 0 },
    ]);
  });

  it('keeps texts apart across a step, a call or shown reasoning', () => {
    expect(renderedSteps(message(stepStart, part, stepStart, part)).adjacent).toEqual([]);
    const toolCall = {
      args: {},
      argsText: '{}',
      toolCallId: 'c',
      toolName: 't',
      type: 'tool-call',
    };
    expect(renderedSteps(message(stepStart, part, toolCall, part)).adjacent).toEqual([]);
    expect(
      renderedSteps(message(stepStart, part, { text: 'why', type: 'reasoning' }, part)).adjacent
    ).toEqual([]);
  });
});
