import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DatabaseDrawer } from '../database-drawer';

const { mockPreloadDatabaseTab } = vi.hoisted(() => ({
  mockPreloadDatabaseTab: vi.fn(() => Promise.resolve()),
}));

const mockDatabaseTabRender = vi.fn();

afterEach(() => {
  mockPreloadDatabaseTab.mockClear();
  mockDatabaseTabRender.mockClear();
});

vi.mock('../database-tab', () => ({
  DatabaseTab: () => {
    mockDatabaseTabRender();
    return <div data-testid="mock-database-panel">Database mock</div>;
  },
  preloadDatabaseTab: mockPreloadDatabaseTab,
}));

describe('DatabaseDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('mounts database content directly', async () => {
    render(<DatabaseDrawer />);

    expect(await screen.findByTestId('database-drawer')).toBeInTheDocument();
    expect(await screen.findByTestId('mock-database-panel')).toBeInTheDocument();
    expect(mockDatabaseTabRender).toHaveBeenCalledTimes(1);
  });

  test('preloads the database tab chunk on mount when requested', async () => {
    render(<DatabaseDrawer preloadDatabaseTabOnMount />);

    await waitFor(() => {
      expect(mockPreloadDatabaseTab).toHaveBeenCalledTimes(1);
    });
  });
});
