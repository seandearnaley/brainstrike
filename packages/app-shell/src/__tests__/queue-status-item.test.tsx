import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueueStatusItem } from '../status-items/queue-status-item';

vi.mock(
  '@brainstrike/vector-management',
  async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    return {
      QueueStatusPopover: () => <div data-testid="queue-status-popover">Queue Status</div>,
    };
  },
  // @ts-expect-error - Vitest accepts virtual mocks at runtime.
  { virtual: true }
);

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
