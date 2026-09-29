import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueStatusItem } from '../status-items/queue-status-item';

const lazyModuleGate = vi.hoisted(() => {
  let releaseModule: (() => void) | undefined;
  const pendingModule = new Promise<void>((resolve) => {
    releaseModule = resolve;
  });
  return {
    pendingModule,
    release(): void {
      if (!releaseModule) {
        throw new Error('Queue status module gate was not initialized');
      }
      releaseModule();
    },
  };
});

vi.mock('@brainstrike/vector-management', async () => {
  await lazyModuleGate.pendingModule;
  return {
    QueueStatusPopover: () => <div data-testid="queue-status-popover">Queue Status</div>,
  };
});

// React.lazy memoizes the module-level LazyQueueStatusPopover after this one-shot gate resolves,
// so only the first render in this file can observe the pending boundary. Keep one rendering test.
afterEach(() => {
  lazyModuleGate.release();
});

describe('QueueStatusItem', () => {
  it('renders no placeholder while the real lazy module boundary is pending', async () => {
    const { container } = render(<QueueStatusItem />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-status-popover')).not.toBeInTheDocument();

    await act(async () => {
      lazyModuleGate.release();
    });

    expect(await screen.findByTestId('queue-status-popover')).toHaveTextContent('Queue Status');
  });
});
