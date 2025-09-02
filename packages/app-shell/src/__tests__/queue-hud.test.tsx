import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// We will mock @brainstrike/db to control JobQueue behavior
vi.mock('@brainstrike/db', () => {
  const getQueueStats = vi.fn(async () => [
    {
      queue: 'embeddings',
      queued: 1,
      running: 0,
      failed: 2,
      succeeded: 3,
      nextRunnableAt: '2025-01-01T00:00:00Z',
    },
  ]);
  const requeueFailed = vi.fn(async () => undefined);

  class MockJobQueue {
    async getQueueStats(...args: unknown[]) {
      return getQueueStats(...(args as []));
    }
    async requeueFailed(...args: unknown[]) {
      return requeueFailed(...(args as []));
    }
  }
  const usePGliteDatabase = vi.fn(() => ({}));
  return { JobQueue: MockJobQueue, usePGliteDatabase, __mocks__: { getQueueStats, requeueFailed } };
});

// Helper to dynamically import fresh module after changing globals
async function importFresh() {
  vi.resetModules();
  return await import('../queue-hud');
}

describe.skip('QueueHud', () => {
  it('renders stats and enables retry when failures exist', async () => {
    const { QueueHud } = await importFresh();
    render(<QueueHud />);

    // Initial mocked stats should render
    await waitFor(() => {
      expect(screen.getByText('Queued')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument(); // queued
      expect(screen.getByText('2')).toBeInTheDocument(); // failed
      expect(screen.getByLabelText('Retry failed jobs')).toBeEnabled();
    });

    // Retry should trigger requeue and refresh stats
    const retry = screen.getByRole('button', { name: /retry failed/i });
    const user = userEvent.setup();

    // Update mock to reflect that failures drop to 0 after retry
    const db = await import('@brainstrike/db');
    const mocks = (
      db as unknown as {
        __mocks__: {
          requeueFailed: ReturnType<typeof vi.fn>;
          getQueueStats: ReturnType<typeof vi.fn>;
        };
      }
    ).__mocks__;
    mocks.requeueFailed.mockResolvedValue(undefined);
    mocks.getQueueStats.mockResolvedValueOnce([
      {
        queue: 'embeddings',
        queued: 0,
        running: 0,
        failed: 0,
        succeeded: 5,
        nextRunnableAt: null,
      },
    ]);

    // Freeze timers so internal interval does not fire after the update
    vi.useFakeTimers();
    await user.click(retry);

    await waitFor(() => {
      // Failed count updated to 0 and button becomes disabled
      expect(screen.getByText('0')).toBeInTheDocument();
      expect(screen.getByLabelText('Retry failed jobs')).toBeDisabled();
    });
    vi.useRealTimers();
  });
});
