import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AssistantRunTimeline } from '../assistant-run-timeline';

it('renders answered approval history in past tense without claiming it is waiting', () => {
  render(
    <TooltipProvider>
      <AssistantRunTimeline
        data={{
          id: 'answered',
          kind: 'tool.approval.requested',
          label: 'Awaiting your approval',
          metadata: { toolCallId: 'read' },
          status: 'running',
          timestamp: '2026-09-27T20:21:00Z',
        }}
        statusOverride="completed"
      />
    </TooltipProvider>
  );
  expect(screen.getByText('Approval requested')).toBeInTheDocument();
  expect(screen.queryByText('Awaiting your approval')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Completed')).toBeInTheDocument();
});
