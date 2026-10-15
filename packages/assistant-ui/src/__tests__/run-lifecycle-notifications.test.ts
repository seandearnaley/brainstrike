// @vitest-environment node
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import { describe, expect, it } from 'vitest';
import {
  createEditActivityRunEventsSelector,
  createTerminalRunEventsSelector,
  createToolApprovalRequestsSelector,
  selectTerminalRunEvents,
  selectToolApprovalRequests,
} from '../run-lifecycle-notifications';

function runEventMessage(event: Record<string, unknown>) {
  return { content: [{ data: event, name: ASSISTANT_RUN_EVENT_DATA_NAME }] };
}

function approvalMessage(request: Record<string, unknown>) {
  return { content: [{ data: request, name: TOOL_APPROVAL_DATA_NAME }] };
}

const ts = '2026-07-09T10:00:00.000Z';

function countedParts(parts: unknown[], reads: { count: number }): unknown[] {
  return new Proxy(parts, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        reads.count += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('incremental lifecycle selectors', () => {
  it('does not re-read earlier message parts when streaming appends to the last message', () => {
    const earlierReads = { count: 0 };
    const lastReads = { count: 0 };
    const earlierParts = countedParts(
      [
        runEventMessage({
          id: 'finished',
          kind: 'run.finished',
          label: 'Done',
          status: 'completed',
          timestamp: ts,
        }).content[0],
      ],
      earlierReads
    );
    const lastParts = countedParts([], lastReads);
    const selectEvents = createTerminalRunEventsSelector();
    const selectApprovals = createToolApprovalRequestsSelector();
    const messages = () => [
      { content: earlierParts, id: 'earlier' },
      { content: lastParts, id: 'streaming' },
    ];

    selectEvents(messages());
    selectApprovals(messages());
    const initialEarlierReads = earlierReads.count;

    for (let index = 0; index < 8; index += 1) {
      lastParts.push({ text: `chunk-${index}`, type: 'text' });
      selectEvents(messages());
      selectApprovals(messages());
    }

    expect(initialEarlierReads).toBe(2);
    expect(earlierReads.count).toBe(initialEarlierReads);
    expect(lastReads.count).toBe(16);
  });
});

describe('selectTerminalRunEvents', () => {
  it('returns run.finished and run.failed events, in order', () => {
    const messages = [
      runEventMessage({
        id: 'e1',
        kind: 'run.started',
        label: 'Started',
        status: 'running',
        timestamp: ts,
      }),
      runEventMessage({
        id: 'e2',
        kind: 'tool.completed',
        label: 'Tool done',
        status: 'completed',
        timestamp: ts,
      }),
      runEventMessage({
        id: 'e3',
        kind: 'run.finished',
        label: 'Done',
        runId: 'run-1',
        status: 'completed',
        timestamp: ts,
      }),
    ];

    const result = selectTerminalRunEvents(messages);
    expect(result.map((event) => event.id)).toEqual(['e3']);
  });

  it('includes run.failed events', () => {
    const messages = [
      runEventMessage({
        id: 'e1',
        kind: 'run.failed',
        label: 'Failed',
        runId: 'run-1',
        status: 'failed',
        timestamp: ts,
      }),
    ];

    expect(selectTerminalRunEvents(messages).map((event) => event.id)).toEqual(['e1']);
  });

  it('ignores non-run-event data parts and malformed payloads', () => {
    const messages = [
      { content: [{ data: { kind: 'run.finished' }, name: 'some.other.name' }] },
      { content: [{ data: 'not-an-object', name: ASSISTANT_RUN_EVENT_DATA_NAME }] },
      { content: [{ data: { kind: 'run.finished' }, name: ASSISTANT_RUN_EVENT_DATA_NAME }] }, // missing id/status/timestamp
    ];

    expect(selectTerminalRunEvents(messages)).toEqual([]);
  });

  it('returns an empty array for an empty thread', () => {
    expect(selectTerminalRunEvents([])).toEqual([]);
  });
});

describe('selectToolApprovalRequests', () => {
  it('deduplicates forwarded child notices without losing a later leaf pause on the same parent call', () => {
    const path = [
      {
        childRuntimeRunId: 'child-run',
        parentRuntimeRunId: 'root-run',
        parentToolCallId: 'delegate-1',
        personaId: 'worker',
      },
    ];
    const first = {
      delegation: { path, toolCallId: 'edit-1' },
      runId: 'root-run',
      toolCallId: 'delegate-1',
      toolName: 'editFile',
    };
    const forwarded = { ...first, runId: 'child-run', toolCallId: 'edit-1' };
    const next = { ...first, delegation: { path, toolCallId: 'edit-2' } };
    const select = createToolApprovalRequestsSelector();
    const messages = [approvalMessage(first), approvalMessage(forwarded)];
    expect(selectToolApprovalRequests(messages)).toEqual([first]);
    expect(JSON.parse(select(messages))).toEqual([first]);
    messages.push(approvalMessage(next));
    expect(selectToolApprovalRequests(messages)).toEqual([first, next]);
    expect(JSON.parse(select(messages))).toEqual([first, next]);
  });

  it('returns every well-formed tool-approval-required request', () => {
    const messages = [
      approvalMessage({ runId: 'run-1', toolCallId: 'call-1', toolName: 'brainstrike.editFile' }),
    ];

    const result = selectToolApprovalRequests(messages);
    expect(result).toEqual([
      { runId: 'run-1', toolCallId: 'call-1', toolName: 'brainstrike.editFile' },
    ]);
  });

  it('dedupes by runId+toolCallId, keeping the first occurrence', () => {
    const messages = [
      approvalMessage({
        args: { first: true },
        runId: 'run-1',
        toolCallId: 'call-1',
        toolName: 'a',
      }),
      approvalMessage({
        args: { first: false },
        runId: 'run-1',
        toolCallId: 'call-1',
        toolName: 'a',
      }),
    ];

    const result = selectToolApprovalRequests(messages);
    expect(result).toHaveLength(1);
    expect((result[0] as { args?: { first?: boolean } }).args?.first).toBe(true);
  });

  it('ignores malformed approval payloads', () => {
    const messages = [
      approvalMessage({ runId: 'run-1' }), // missing toolCallId/toolName
      { content: [{ data: null, name: TOOL_APPROVAL_DATA_NAME }] },
    ];

    expect(selectToolApprovalRequests(messages)).toEqual([]);
  });

  it('returns an empty array for an empty thread', () => {
    expect(selectToolApprovalRequests([])).toEqual([]);
  });
});

describe('createEditActivityRunEventsSelector', () => {
  const editEvent = (id: string, toolName: string) => ({
    id,
    kind: 'tool.completed',
    label: 'Tool completed',
    metadata: { toolName },
    status: 'completed',
    timestamp: ts,
  });

  function selected(messages: unknown[]): Array<{ id: string; kind: string }> {
    return JSON.parse(createEditActivityRunEventsSelector()(messages));
  }

  it('reports run.started so a live view can retarget before the run ends', () => {
    expect(
      selected([
        runEventMessage({
          id: 'started',
          kind: 'run.started',
          label: 'Run started',
          runId: 'run-1',
          status: 'running',
          timestamp: ts,
        }),
      ]).map((event) => event.kind)
    ).toEqual(['run.started']);
  });

  it('reports a completed file-mutation tool, by its dotted AND its Mastra-sanitized name', () => {
    expect(
      selected([
        runEventMessage(editEvent('dotted', NATIVE_TOOL_ID.writeWorkspaceFile)),
        runEventMessage(editEvent('sanitized', 'brainstrike_writeWorkspaceFile')),
      ]).map((event) => event.id)
    ).toEqual(['dotted', 'sanitized']);
  });

  it('ignores a completed READ-ONLY tool — a live refresh must cost nothing on a quiet run', () => {
    expect(
      selected([runEventMessage(editEvent('read', NATIVE_TOOL_ID.readWorkspaceFile))])
    ).toEqual([]);
  });

  it('ignores tool.started and tool.failed — only a COMPLETED edit journals a row', () => {
    expect(
      selected([
        runEventMessage({
          ...editEvent('started', NATIVE_TOOL_ID.writeWorkspaceFile),
          kind: 'tool.started',
          status: 'running',
        }),
        runEventMessage({
          ...editEvent('failed', NATIVE_TOOL_ID.writeWorkspaceFile),
          kind: 'tool.failed',
          status: 'failed',
        }),
      ])
    ).toEqual([]);
  });

  it("reports a SUBAGENT's completed edit — a delegated write changes the same files", () => {
    expect(
      selected([
        runEventMessage({
          ...editEvent('subagent', NATIVE_TOOL_ID.writeWorkspaceFile),
          kind: 'subagent.tool.completed',
        }),
      ]).map((event) => event.id)
    ).toEqual(['subagent']);
  });
});
