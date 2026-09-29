import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  type AssistantRunEvent,
} from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { beforeAll, expect, it } from 'vitest';
import {
  deriveAssistantRunEventRows,
  resolveAssistantRunEventStatus,
} from '../assistant-run-event-derivation';
import { AssistantRunTimeline } from '../assistant-run-timeline';
import { delegatedTaskTerminalError } from '../delegated-terminal-status';
import { resolveErrorMessage } from '../tool-fallback-state';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
});

function approval(id: string, toolCallId: string, runId: string): AssistantRunEvent {
  return {
    id,
    kind: 'tool.approval.requested',
    label: 'Awaiting your approval',
    metadata: { toolCallId, toolName: 'brainstrike.executeCommand' },
    runId,
    status: 'running',
    timestamp: '2026-09-17T00:00:00Z',
  };
}

function message(event: AssistantRunEvent, status: object) {
  return {
    parts: [
      { data: event, name: ASSISTANT_RUN_EVENT_DATA_NAME, type: 'data' },
      {
        data: {
          runId: event.runId,
          toolCallId: event.metadata?.['toolCallId'],
          toolName: 'brainstrike.executeCommand',
        },
        name: 'brainstrike.tool-approval',
        type: 'data',
      },
    ],
    role: 'assistant',
    status,
  };
}

it.each(['error', 'cancelled'] as const)(
  'retires only the %s child pause when its receiver closes incomplete',
  (reason) => {
    const failed = approval('failed-pause', 'call-failed', 'run-failed');
    const parked = approval('parked-pause', 'call-parked', 'run-parked');
    const messages = [
      message(failed, {
        error: delegatedTaskTerminalError(reason === 'error' ? 'failed' : 'cancelled'),
        reason,
        type: 'incomplete',
      }),
      message(parked, { reason: 'stop', type: 'complete' }),
    ];

    expect(resolveAssistantRunEventStatus(messages, failed)).toBe('interrupted');
    const derived = deriveAssistantRunEventRows(messages);
    expect(derived.statuses).toMatchObject({
      'failed-pause': 'interrupted',
      'parked-pause': 'running',
    });
    const status = derived.statuses[failed.id];
    if (!status) {
      throw new Error('Missing derived failed-child pause status.');
    }

    render(
      <TooltipProvider>
        <AssistantRunTimeline data={failed} statusOverride={status} />
      </TooltipProvider>
    );
    expect(screen.getByText('Approval was pending')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(0);
    expect(
      resolveErrorMessage(
        {
          error: delegatedTaskTerminalError(reason === 'error' ? 'failed' : 'cancelled'),
          reason,
          type: 'incomplete',
        },
        undefined,
        false
      )
    ).toBe(
      `Delegated task ${reason === 'error' ? 'failed' : 'cancelled'} before its child stream emitted a terminal.`
    );
  }
);

it('uses a persisted child run terminal to retire its old complete pause after reload', () => {
  const failed = approval('failed-pause', 'call-failed', 'child-host-run');
  const parked = approval('parked-pause', 'call-parked', 'other-child-run');
  const terminal: AssistantRunEvent = {
    id: 'child-terminal',
    kind: 'run.failed',
    label: 'Background child failed',
    runId: 'child-host-run',
    status: 'failed',
    timestamp: '2026-09-17T00:00:02Z',
  };
  const messages = [
    message(failed, { type: 'complete' }),
    message(parked, { type: 'complete' }),
    {
      parts: [{ data: terminal, name: ASSISTANT_RUN_EVENT_DATA_NAME, type: 'data' }],
      role: 'assistant',
      status: { type: 'complete' },
    },
  ];
  expect(resolveAssistantRunEventStatus(messages, failed)).toBe('failed');
  expect(deriveAssistantRunEventRows(messages).statuses).toMatchObject({
    'failed-pause': 'failed',
    'parked-pause': 'running',
  });
});

it('keeps a pause alive when another generation fails or its message has an unrelated error', () => {
  const parked = approval('parked-pause', 'call-parked', 'parked-run');
  const otherTerminal: AssistantRunEvent = {
    id: 'other-terminal',
    kind: 'run.failed',
    label: 'Other run failed',
    runId: 'other-run',
    status: 'failed',
    timestamp: '2026-09-17T00:00:02Z',
  };
  const messages = [
    message(parked, { error: 'Parent transport failed.', reason: 'error', type: 'incomplete' }),
    {
      parts: [{ data: otherTerminal, name: ASSISTANT_RUN_EVENT_DATA_NAME, type: 'data' }],
      role: 'assistant',
      status: { type: 'complete' },
    },
  ];
  expect(resolveAssistantRunEventStatus(messages, parked)).toBe('running');
  expect(deriveAssistantRunEventRows(messages).statuses[parked.id]).toBe('running');
});
