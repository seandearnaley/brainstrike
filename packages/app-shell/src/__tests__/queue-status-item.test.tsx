import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueueStatusItem } from '../status-items/queue-status-item';

vi.mock('@brainstrike/vector-management', () => ({
  QueueStatusPopover: () => <div data-testid="queue-status-popover">Queue Status</div>,
}));

describe('QueueStatusItem', () => {
  it('renders the QueueStatusPopover after lazy load resolves', async () => {
    render(<QueueStatusItem />);

    await waitFor(() => {
      expect(screen.getByTestId('queue-status-popover')).toBeInTheDocument();
    });
  });

  it('uses null Suspense fallback (no spinner or placeholder)', async () => {
    render(<QueueStatusItem />);

    // The only thing that should ever appear is the popover — no loading indicator
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('queue-status-popover')).toBeInTheDocument();
    });
  });

  it('renders QueueStatusPopover content after resolution', async () => {
    render(<QueueStatusItem />);

    await waitFor(() => {
      expect(screen.getByText('Queue Status')).toBeInTheDocument();
    });
  });
});
