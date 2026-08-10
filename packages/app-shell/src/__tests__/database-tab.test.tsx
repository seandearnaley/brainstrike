import type { QueueAdapter } from '@brainstrike/queue';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let capturedChunkProps: Record<string, unknown> | null = null;

const { mockDatabaseTabChunkFactory } = vi.hoisted(() => ({
  mockDatabaseTabChunkFactory: vi.fn(
    (): Promise<{ DatabaseTab: (props: Record<string, unknown>) => ReactNode }> =>
      Promise.resolve({
        DatabaseTab: (props) => {
          capturedChunkProps = props;
          return <div>Database overview chunk</div>;
        },
      })
  ),
}));

vi.mock('../database-tab-chunk', () => mockDatabaseTabChunkFactory());

beforeEach(() => {
  capturedChunkProps = null;
  mockDatabaseTabChunkFactory.mockReset();
  mockDatabaseTabChunkFactory.mockResolvedValue({
    DatabaseTab: (props) => {
      capturedChunkProps = props;
      return <div>Database overview chunk</div>;
    },
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
    expect(capturedChunkProps).toEqual({ embeddingQueue: null });
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

describe('DatabaseTab load-failure recovery (PR #2381 review)', () => {
  it('offers a retry that succeeds after a transient queue-init rejection', async () => {
    const user = userEvent.setup();
    const { DatabaseTab } = await import('../database-tab');

    // The queue keeps failing until the user retries. Two rejections, not one:
    // the component half resolving re-runs the effect, which re-attempts the
    // still-missing queue on its own — so a single rejection self-heals and
    // would never reach the error UI.
    //
    // Before the fix this latched: Promise.all rejected as a unit, so the
    // resolved component was discarded with it and nothing could re-drive it.
    const queue = { enqueue: vi.fn() } as unknown as QueueAdapter;
    const loadEmbeddingQueue = vi
      .fn<() => Promise<QueueAdapter>>()
      .mockRejectedValueOnce(new Error('queue boot failed'))
      .mockRejectedValueOnce(new Error('queue boot failed'))
      .mockResolvedValue(queue);

    render(<DatabaseTab loadEmbeddingQueue={loadEmbeddingQueue} />);

    const error = await screen.findByTestId('database-tab-load-error');
    expect(error).toHaveTextContent(/queue boot failed/);

    await user.click(screen.getByTestId('database-tab-load-retry'));

    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
    expect(screen.queryByTestId('database-tab-load-error')).not.toBeInTheDocument();
    // Only the QUEUE half was re-attempted: two automatic tries plus the
    // explicit retry. The component half, which resolved on the first attempt,
    // survived the failures rather than being discarded with them.
    expect(loadEmbeddingQueue).toHaveBeenCalledTimes(3);
  });
});
