import type { AssistantRunEvent } from '@brainstrike/agent';
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

  it('expands to show sanitized event metadata', async () => {
    const user = userEvent.setup();
    render(<AssistantRunTimeline data={baseEvent} />);

    await user.click(screen.getByRole('button', { name: /expand run activity/i }));

    expect(screen.getByText('threadId')).toBeInTheDocument();
    expect(screen.getByText('thread-1')).toBeInTheDocument();
    expect(screen.getByText('resourceId')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /collapse run activity/i })).toBeInTheDocument();
  });

  it('renders nothing for malformed data parts', () => {
    const { container } = render(<AssistantRunTimeline data={{ label: 'Missing fields' }} />);

    expect(container).toBeEmptyDOMElement();
  });
});
