import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueueStatusItem } from '../status-items/queue-status-item';

vi.mock('@brainstrike/vector-management', () => ({
  QueueStatusPopover: () => <div data-testid="queue-status-popover">Queue Status</div>,
}));

describe('QueueStatusItem', () => {
  it('uses null Suspense fallback (no spinner or placeholder)', async () => {
    render(<QueueStatusItem />);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();

    expect(await screen.findByTestId('queue-status-popover')).toBeInTheDocument();
  });

  it('renders QueueStatusPopover content after resolution', async () => {
    render(<QueueStatusItem />);

    expect(await screen.findByText('Queue Status')).toBeInTheDocument();
  });
});
