import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { describe, expect, it } from 'vitest';
import {
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
