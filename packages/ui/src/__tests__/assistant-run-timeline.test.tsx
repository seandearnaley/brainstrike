import type { AssistantRunEvent } from '@brainstrike/agent/run-events';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AssistantRunTimeline } from '../assistant-ui-panel/assistant-run-timeline';

const baseEvent = {
  id: 'event-1',
  kind: 'memory.configured',
  label: 'Memory configured',
  runId: 'run-1',
  sequence: 1,
  status: 'completed',
  timestamp: '2026-04-24T12:00:00.000Z',
  metadata: {
    threadId: 'thread-1',
    resourceId: 'workspace-1',
  },
} satisfies AssistantRunEvent;

describe('AssistantRunTimeline', () => {
  it('renders a compact assistant activity row by default', () => {
    render(<AssistantRunTimeline data={baseEvent} />);

    expect(screen.getByTestId('assistant-run-timeline')).toBeInTheDocument();
    expect(screen.getByText('Memory configured')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('threadId')).not.toBeInTheDocument();
  });

  it('renders running, failed, cancelled, and informational status labels', () => {
    const cases = [
      ['running', 'Semantic recall'],
      ['failed', 'Tool failed'],
      ['cancelled', 'Run cancelled'],
      ['info', 'Context budget'],
    ] as const;

    render(
      cases.map(([status, label], index) => (
        <AssistantRunTimeline
          data={{
            ...baseEvent,
            id: `event-${status}`,
            kind: `run.${status}`,
            label,
            sequence: index + 2,
            status,
          }}
          key={status}
        />
      ))
    );

    expect(screen.getByText('Semantic recall')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Tool failed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Run cancelled')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Context budget')).toBeInTheDocument();
    expect(screen.getByText('Observed')).toBeInTheDocument();
  });

  it('expands to show sanitized event metadata', async () => {
    const user = userEvent.setup();
    render(<AssistantRunTimeline data={baseEvent} />);

    await user.click(screen.getByRole('button', { name: /expand run activity/i }));

    expect(screen.getByText('threadId')).toBeInTheDocument();
    expect(screen.getByText('thread-1')).toBeInTheDocument();
    expect(screen.getByText('resourceId')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /collapse run activity/i })).toBeInTheDocument();
  });

  it('expands detail text and JSON-safe metadata values', async () => {
    const user = userEvent.setup();
    render(
      <AssistantRunTimeline
        data={{
          ...baseEvent,
          detail: 'Loaded 4 semantic candidates.',
          durationMs: 1420,
          metadata: {
            hitCount: 4,
            cached: false,
            filters: ['typescript', 'ui'],
            nullable: null,
          },
        }}
      />
    );

    expect(screen.getByText('1.4s')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /expand run activity/i }));

    expect(screen.getByText('Loaded 4 semantic candidates.')).toBeInTheDocument();
    expect(screen.getByText('hitCount')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('cached')).toBeInTheDocument();
    expect(screen.getByText('false')).toBeInTheDocument();
    expect(screen.getByText('filters')).toBeInTheDocument();
    expect(screen.getByText('["typescript","ui"]')).toBeInTheDocument();
    expect(screen.getByText('nullable')).toBeInTheDocument();
    expect(screen.getByText('null')).toBeInTheDocument();
  });

  it('renders millisecond durations and invalid timestamps without coercion', () => {
    render(
      <AssistantRunTimeline
        data={{
          ...baseEvent,
          durationMs: 250,
          timestamp: 'not-a-date',
        }}
      />
    );

    expect(screen.getByText('250ms')).toBeInTheDocument();
    expect(screen.getByText('not-a-date')).toBeInTheDocument();
  });

  it('renders nothing for malformed data parts', () => {
    const { container } = render(<AssistantRunTimeline data={{ label: 'Missing fields' }} />);

    expect(container).toBeEmptyDOMElement();
  });
});
