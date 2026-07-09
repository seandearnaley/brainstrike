import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunLifecycleNotificationBridge } from '../run-lifecycle-notifications';

// useAuiState must be mocked so RunLifecycleNotificationBridge can be tested
// without a live AssistantRuntimeProvider. The mock reads a configurable
// messages list directly (no subscription), so a later `rerender()` after
// mutating `mockMessages` is what surfaces a "new" snapshot — mirrors the
// pattern in context-usage-meter.test.tsx. `vi.mock` is hoisted above this
// import, so the mock is in place before `run-lifecycle-notifications`
// (and its `@assistant-ui/react` import) is evaluated.
let mockMessages: unknown[] = [];
vi.mock('@assistant-ui/react', () => ({
  useAuiState: <T,>(selector: (state: { thread: { messages: unknown[] } }) => T) =>
    selector({ thread: { messages: mockMessages } }),
}));

function runEventMessage(event: Record<string, unknown>) {
  return { content: [{ data: event, name: ASSISTANT_RUN_EVENT_DATA_NAME }] };
}

function approvalMessage(request: Record<string, unknown>) {
  return { content: [{ data: request, name: TOOL_APPROVAL_DATA_NAME }] };
}

const ts = '2026-07-09T10:00:00.000Z';

describe('useRunLifecycleNotifications hydration guard', () => {
  beforeEach(() => {
    mockMessages = [];
  });

  it('does not replay callbacks for run.finished/run.failed/approval history already present on mount', () => {
    mockMessages = [
      runEventMessage({
        id: 'e1',
        kind: 'run.finished',
        label: 'Done',
        status: 'completed',
        timestamp: ts,
      }),
      runEventMessage({
        id: 'e2',
        kind: 'run.failed',
        label: 'Failed',
        status: 'failed',
        timestamp: ts,
      }),
      approvalMessage({ runId: 'run-1', toolCallId: 'call-1', toolName: 'brainstrike.editFile' }),
    ];

    const onRunFinished = vi.fn();
    const onRunFailed = vi.fn();
    const onToolApprovalRequired = vi.fn();

    render(
      <RunLifecycleNotificationBridge
        onRunFailed={onRunFailed}
        onRunFinished={onRunFinished}
        onToolApprovalRequired={onToolApprovalRequired}
      />
    );

    expect(onRunFinished).not.toHaveBeenCalled();
    expect(onRunFailed).not.toHaveBeenCalled();
    expect(onToolApprovalRequired).not.toHaveBeenCalled();
  });

  it('fires exactly once for a genuinely new run event arriving after mount', () => {
    mockMessages = [
      runEventMessage({
        id: 'e1',
        kind: 'run.finished',
        label: 'Done',
        status: 'completed',
        timestamp: ts,
      }),
    ];

    const onRunFinished = vi.fn();
    const { rerender } = render(<RunLifecycleNotificationBridge onRunFinished={onRunFinished} />);
    expect(onRunFinished).not.toHaveBeenCalled();

    mockMessages = [
      ...mockMessages,
      runEventMessage({
        id: 'e2',
        kind: 'run.finished',
        label: 'Done again',
        status: 'completed',
        timestamp: ts,
      }),
    ];
    rerender(<RunLifecycleNotificationBridge onRunFinished={onRunFinished} />);

    expect(onRunFinished).toHaveBeenCalledTimes(1);
    expect(onRunFinished.mock.calls[0]?.[0]).toMatchObject({ id: 'e2' });
  });

  it('fires exactly once for a genuinely new tool-approval request arriving after mount', () => {
    mockMessages = [
      approvalMessage({ runId: 'run-1', toolCallId: 'call-1', toolName: 'brainstrike.editFile' }),
    ];

    const onToolApprovalRequired = vi.fn();
    const { rerender } = render(
      <RunLifecycleNotificationBridge onToolApprovalRequired={onToolApprovalRequired} />
    );
    expect(onToolApprovalRequired).not.toHaveBeenCalled();

    mockMessages = [
      ...mockMessages,
      approvalMessage({ runId: 'run-2', toolCallId: 'call-2', toolName: 'brainstrike.editFile' }),
    ];
    rerender(<RunLifecycleNotificationBridge onToolApprovalRequired={onToolApprovalRequired} />);

    expect(onToolApprovalRequired).toHaveBeenCalledTimes(1);
    expect(onToolApprovalRequired.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-2',
      toolCallId: 'call-2',
    });
  });

  it('re-seeds without replay on a thread switch, but still notifies for new events on the new thread', () => {
    mockMessages = [
      runEventMessage({
        id: 't1-e1',
        kind: 'run.finished',
        label: 'Thread 1 done',
        status: 'completed',
        timestamp: ts,
      }),
    ];
    const onRunFinished = vi.fn();
    const { rerender } = render(
      <RunLifecycleNotificationBridge onRunFinished={onRunFinished} threadKey="thread-1" />
    );
    expect(onRunFinished).not.toHaveBeenCalled();

    // Switch threads: the new thread's own pre-existing history (a
    // DIFFERENT terminal event) must not replay either — this is the
    // "re-seed rather than replay" requirement.
    mockMessages = [
      runEventMessage({
        id: 't2-e1',
        kind: 'run.finished',
        label: 'Thread 2 done',
        status: 'completed',
        timestamp: ts,
      }),
    ];
    rerender(<RunLifecycleNotificationBridge onRunFinished={onRunFinished} threadKey="thread-2" />);
    expect(onRunFinished).not.toHaveBeenCalled();

    // A genuinely new event on the new thread still fires exactly once.
    mockMessages = [
      ...mockMessages,
      runEventMessage({
        id: 't2-e2',
        kind: 'run.finished',
        label: 'Thread 2 new',
        status: 'completed',
        timestamp: ts,
      }),
    ];
    rerender(<RunLifecycleNotificationBridge onRunFinished={onRunFinished} threadKey="thread-2" />);
    expect(onRunFinished).toHaveBeenCalledTimes(1);
    expect(onRunFinished.mock.calls[0]?.[0]).toMatchObject({ id: 't2-e2' });
  });
});
