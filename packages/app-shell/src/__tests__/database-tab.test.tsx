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
    expect(screen.getByTestId('database-tab-loading')).toBeInTheDocument();
    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
  });

  it('renders the database tab chunk content once the lazy module resolves', async () => {
    const { DatabaseTab } = await import('../database-tab');

    render(<DatabaseTab />);
    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
  });
});
