import type { QueueAdapter } from '@brainstrike/queue';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDatabaseTabChunkFactory } = vi.hoisted(() => ({
  mockDatabaseTabChunkFactory: vi.fn(
    (): Promise<{ DatabaseTab: () => ReactNode }> =>
      Promise.resolve({ DatabaseTab: () => <div>Database overview chunk</div> })
  ),
}));

vi.mock('../database-tab-chunk', () => mockDatabaseTabChunkFactory());

beforeEach(() => {
  mockDatabaseTabChunkFactory.mockReset();
  mockDatabaseTabChunkFactory.mockResolvedValue({
    DatabaseTab: () => <div>Database overview chunk</div>,
  });
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe('DatabaseTab', () => {
  it('renders the loading fallback before the chunk resolves and then shows content', async () => {
    const { DatabaseTab } = await import('../database-tab');

    render(<DatabaseTab />);
    const stableFrame = screen.getByTestId('database-tab-frame');
    expect(stableFrame).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('database-tab-loading')).toHaveClass('h-full');
    expect(screen.getByTestId('database-tab-loading-toolbar')).toHaveClass('h-9');
    expect(screen.getByTestId('database-tab-loading-toolbar')).toHaveClass(
      '@container/database-toolbar'
    );
    expect(screen.getByTestId('database-tab-loading-settings')).toHaveClass('@[360px]:w-20', 'w-7');
    expect(screen.getByTestId('database-tab-loading-top-panel')).toHaveClass('flex-[38]');
    expect(screen.getByTestId('database-tab-loading-actions')).toHaveClass('h-9');
    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
    expect(screen.getByTestId('database-tab-frame')).toBe(stableFrame);
    expect(stableFrame).toHaveAttribute('aria-busy', 'false');
  });

  it('keeps the stable loading frame mounted until the embedding queue is ready', async () => {
    const { DatabaseTab } = await import('../database-tab');
    let resolveQueue: ((queue: QueueAdapter) => void) | undefined;
    const queueLoader = vi.fn(
      () =>
        new Promise<QueueAdapter>((resolve) => {
          resolveQueue = resolve;
        })
    );

    render(<DatabaseTab loadEmbeddingQueue={queueLoader} />);

    const stableFrame = screen.getByTestId('database-tab-frame');
    expect(stableFrame).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Database overview chunk')).not.toBeInTheDocument();

    resolveQueue?.({
      add: vi.fn(),
      addBulk: vi.fn(),
      cancel: vi.fn(),
      drain: vi.fn(),
      isPaused: false,
      isProcessing: false,
      onProgress: vi.fn(() => () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
    });

    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
    expect(screen.getByTestId('database-tab-frame')).toBe(stableFrame);
    expect(stableFrame).toHaveAttribute('aria-busy', 'false');
  });

  it('renders the database tab chunk content once the lazy module resolves', async () => {
    const { DatabaseTab } = await import('../database-tab');

    render(<DatabaseTab />);
    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
  });

  it('does not call the queue loader when none is provided', async () => {
    const { DatabaseTab } = await import('../database-tab');

    render(<DatabaseTab />);
    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
  });

  it('loads the embedding queue only when the database tab mounts', async () => {
    const { DatabaseTab } = await import('../database-tab');
    const queueLoader = vi.fn(
      async (): Promise<QueueAdapter> =>
        ({
          add: vi.fn(),
          addBulk: vi.fn(),
          cancel: vi.fn(),
          drain: vi.fn(),
          isPaused: false,
          isProcessing: false,
          onProgress: vi.fn(() => () => {}),
          pause: vi.fn(),
          resume: vi.fn(),
        }) satisfies QueueAdapter
    );

    render(<DatabaseTab loadEmbeddingQueue={queueLoader} />);

    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
    expect(queueLoader).toHaveBeenCalledTimes(1);
  });

  it('renders inline error UI when dependent database loading fails', async () => {
    const { DatabaseTab } = await import('../database-tab');
    const queueLoader = vi.fn(async (): Promise<QueueAdapter> => {
      throw new Error('queue exploded');
    });

    render(<DatabaseTab loadEmbeddingQueue={queueLoader} />);

    expect(await screen.findByTestId('database-tab-load-error')).toHaveTextContent(
      'Failed to load database tools: queue exploded'
    );
    expect(screen.getByRole('alert')).toHaveTextContent('queue exploded');
  });
});
