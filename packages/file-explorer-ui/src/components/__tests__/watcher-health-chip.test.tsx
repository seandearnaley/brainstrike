// BST-568 slice 3: Explorer per-root watcher health chip.
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter, WatcherRootHealthEvent } from '@brainstrike/types';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WatcherHealthChip } from '../watcher-health-chip';

function makeEvent(
  rootPath: string,
  state: WatcherRootHealthEvent['state'],
  message?: string
): WatcherRootHealthEvent {
  return {
    backend: 'fs-events',
    ...(message
      ? {
          failure: {
            code: 'subscribe-failed',
            message,
            retryable: true,
            terminal: false,
          },
        }
      : {}),
    rootPath,
    state,
    timestamp: 1,
    watchId: `watch-${rootPath}`,
  };
}

function renderChip(adapter: Partial<FileSystemAdapter>, rootPath: string) {
  const storageAdapter = {
    clear: vi.fn(),
    getAllKeys: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  };
  return render(
    <AdaptersProvider
      fileSystemAdapter={adapter as FileSystemAdapter}
      storageAdapter={storageAdapter as never}
    >
      <WatcherHealthChip rootPath={rootPath} />
    </AdaptersProvider>
  );
}

describe('WatcherHealthChip', () => {
  it('renders nothing while healthy or without the capability', () => {
    let push: ((event: WatcherRootHealthEvent) => void) | null = null;
    renderChip(
      {
        onWatcherHealth: (callback) => {
          push = callback;
          return () => undefined;
        },
        platform: 'electron',
      },
      '/roots/a'
    );
    expect(screen.queryByTestId('watcher-health-chip')).toBeNull();
    act(() => {
      push?.(makeEvent('/roots/a', 'healthy'));
    });
    expect(screen.queryByTestId('watcher-health-chip')).toBeNull();
  });

  it('shows a failed chip with a working retry action', async () => {
    let push: ((event: WatcherRootHealthEvent) => void) | null = null;
    const retryWatcher = vi.fn().mockResolvedValue({ retried: true });
    renderChip(
      {
        onWatcherHealth: (callback) => {
          push = callback;
          return () => undefined;
        },
        platform: 'electron',
        retryWatcher,
      },
      '/roots/a'
    );
    act(() => {
      push?.(makeEvent('/roots/a', 'failed', 'ENOSPC: watch limit reached'));
    });
    const chip = screen.getByTestId('watcher-health-chip');
    expect(chip.dataset['state']).toBe('failed');

    const retryButton = screen.getByRole('button', {
      name: 'Retry file watching',
    });
    await act(async () => {
      fireEvent.click(retryButton);
    });
    expect(retryWatcher).toHaveBeenCalledWith('/roots/a');
  });

  it('shows a degraded chip without a retry action', () => {
    let push: ((event: WatcherRootHealthEvent) => void) | null = null;
    renderChip(
      {
        onWatcherHealth: (callback) => {
          push = callback;
          return () => undefined;
        },
        platform: 'electron',
      },
      '/roots/a'
    );
    act(() => {
      push?.(makeEvent('/roots/a', 'degraded'));
    });
    expect(screen.getByTestId('watcher-health-chip').dataset['state']).toBe('degraded');
    expect(screen.queryByRole('button', { name: 'Retry file watching' })).toBeNull();
  });

  it('ignores health for other roots', () => {
    let push: ((event: WatcherRootHealthEvent) => void) | null = null;
    renderChip(
      {
        onWatcherHealth: (callback) => {
          push = callback;
          return () => undefined;
        },
        platform: 'electron',
      },
      '/roots/a'
    );
    act(() => {
      push?.(makeEvent('/roots/other', 'failed', 'boom'));
    });
    expect(screen.queryByTestId('watcher-health-chip')).toBeNull();
  });
});
