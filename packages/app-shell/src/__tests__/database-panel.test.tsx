import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DatabasePanel } from '../database-panel';

const mockDatabaseTabRender = vi.fn();

afterEach(() => {
  mockDatabaseTabRender.mockClear();
});

vi.mock('../database-tab', () => ({
  DatabaseTab: () => {
    mockDatabaseTabRender();
    return <div data-testid="mock-database-panel">Database mock</div>;
  },
}));

describe('DatabasePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('mounts database content directly', async () => {
    render(<DatabasePanel />);

    expect(await screen.findByTestId('database-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('mock-database-panel')).toBeInTheDocument();
    expect(mockDatabaseTabRender).toHaveBeenCalledTimes(1);
  });
});
