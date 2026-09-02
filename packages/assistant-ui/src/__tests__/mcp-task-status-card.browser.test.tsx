import '@testing-library/jest-dom/vitest';
import type {
  McpTaskPresentation,
  McpTaskPresentationControllerPort,
} from '@brainstrike/assistant-contract/mcp-task-presentation';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { McpTaskStatusCard } from '../mcp-task-status-card';

const task: McpTaskPresentation = {
  canCancel: true,
  createdAt: '2026-09-01T05:00:00.000Z',
  handle: {
    authorityEpoch: '00000000-0000-7000-8000-000000000000',
    principalId: 'principal-a',
    resource: 'https://tasks.example.test',
    serverId: 'server-a',
    taskId: 'task-a',
  },
  history: [{ at: '2026-09-01T05:00:00.000Z', status: 'working' }],
  omittedHistoryEntries: 0,
  recovery: 'restart_required',
  status: 'working',
  statusMessage: 'Waiting after restart',
  updatedAt: '2026-09-01T05:00:01.000Z',
};

function BrowserHarness({
  controller,
}: {
  readonly controller: McpTaskPresentationControllerPort;
}) {
  const [current, setCurrent] = useState(task);
  return <McpTaskStatusCard controller={controller} onTaskChange={setCurrent} task={current} />;
}

describe('MCP task status card browser behavior', () => {
  it('announces live status and restores focus after keyboard recovery', async () => {
    const recovered = {
      ...task,
      recovery: 'live' as const,
      statusMessage: 'Recovery resumed',
      updatedAt: '2026-09-01T05:00:02.000Z',
    };
    const act = vi.fn<McpTaskPresentationControllerPort['act']>().mockResolvedValue({
      ok: true,
      task: recovered,
    });
    const user = userEvent.setup();
    render(<BrowserHarness controller={{ act }} />);

    expect(screen.getByTestId('mcp-task-status-summary')).toHaveAttribute('role', 'status');
    await user.tab();
    expect(screen.getByText('Status history (1)')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Recover task' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Recovery resumed')).toBeVisible();
    expect(screen.getByTestId('mcp-task-status-summary')).toHaveFocus();
    expect(screen.getByTestId('mcp-task-status-summary')).toHaveTextContent('Working');
  });
});
