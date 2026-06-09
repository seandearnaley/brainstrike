import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { TooltipProvider } from '../../tooltip';
import {
  AssistantRunTimeline,
  getMatchingCompletedKind,
  resolveAssistantRunEventStatus,
} from '../assistant-run-timeline';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
});

function renderTimeline(data: Record<string, unknown>) {
  return render(
    <TooltipProvider>
      <AssistantRunTimeline data={data} />
    </TooltipProvider>
  );
}

function runEventPart(event: Record<string, unknown>) {
  return { name: ASSISTANT_RUN_EVENT_DATA_NAME, data: event };
}

describe('getMatchingCompletedKind', () => {
  it('maps run.step.started to run.step.finished (not .completed)', () => {
    expect(getMatchingCompletedKind('run.step.started')).toBe('run.step.finished');
  });
  it('keeps run.started -> run.finished and tool.started -> tool.completed', () => {
    expect(getMatchingCompletedKind('run.started')).toBe('run.finished');
    expect(getMatchingCompletedKind('tool.started')).toBe('tool.completed');
  });
  it('maps non-run *.started to *.completed', () => {
    expect(getMatchingCompletedKind('memory.semantic.started')).toBe('memory.semantic.completed');
  });
});

describe('resolveAssistantRunEventStatus', () => {
  it('resolves a running generation step to completed when a finished event follows', () => {
    const started = {
      id: 'e1',
      kind: 'run.step.started',
      label: 'Generation step started',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    };
    const finished = {
      id: 'e2',
      kind: 'run.step.finished',
      label: 'Generation step completed',
      status: 'completed',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const messages = [
      { role: 'assistant', parts: [runEventPart(started), runEventPart(finished)] },
    ];
    expect(resolveAssistantRunEventStatus(messages, started as never)).toBe('completed');
  });
});

describe('AssistantRunTimeline render', () => {
  it('tints a memory event, omits the standalone status pill, and hides kind until expanded', () => {
    renderTimeline({
      detail: 'Loaded 3 notes',
      id: 'm1',
      kind: 'memory.working.loaded',
      label: 'Working memory loaded',
      status: 'completed',
      timestamp: '2026-06-05T00:00:00.000Z',
    });
    const card = screen.getByTestId('assistant-run-timeline');
    expect(card.getAttribute('data-tool-category')).toBe('memory');
    expect(screen.queryByText('Completed')).toBeNull(); // no visible pill text
    expect(screen.queryByText('memory.working.loaded')).toBeNull(); // kind only in fold
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText('memory.working.loaded')).toBeInTheDocument();
  });

  it('classifies a tool run event by its tool metadata', () => {
    renderTimeline({
      id: 't1',
      kind: 'tool.completed',
      label: 'Tool completed',
      metadata: { toolName: 'brainstrike.queryEmbeddingSpace' },
      status: 'completed',
      timestamp: '2026-06-05T00:00:00.000Z',
    });
    expect(screen.getByTestId('assistant-run-timeline').getAttribute('data-tool-category')).toBe(
      'internal'
    );
  });

  it('renders running run activity with the shared thinking indicator', () => {
    renderTimeline({
      id: 'r1',
      kind: 'run.step.started',
      label: 'Generating response',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    });

    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-thinking-indicator')).toHaveTextContent('Thinking');
    expect(screen.getByTestId('assistant-thinking-mark')).toHaveAttribute('data-tone', 'greyscale');
  });
});
