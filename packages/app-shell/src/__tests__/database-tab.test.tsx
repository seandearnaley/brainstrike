import { cleanup, render, screen } from '@testing-library/react';
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

  it('renders the database tab chunk content once the lazy module resolves', async () => {
    const { DatabaseTab } = await import('../database-tab');

    render(<DatabaseTab />);
    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
    expect(capturedChunkProps).toEqual({});
  });
});
