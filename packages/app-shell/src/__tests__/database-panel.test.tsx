import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DatabasePanel } from '../database-panel';

const mockDatabaseTabRender = vi.fn();
let capturedDatabaseTabProps: Record<string, unknown> | null = null;

afterEach(() => {
  mockDatabaseTabRender.mockClear();
});

vi.mock('../database-tab', () => ({
  DatabaseTab: (props: Record<string, unknown>) => {
    capturedDatabaseTabProps = props;
    mockDatabaseTabRender();
    return <div data-testid="mock-database-panel">Database mock</div>;
  },
}));

describe('DatabasePanel', () => {
  beforeEach(() => {
    capturedDatabaseTabProps = null;
    vi.clearAllMocks();
  });

  test('mounts database content directly', async () => {
    render(<DatabasePanel />);

    expect(await screen.findByTestId('database-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('mock-database-panel')).toBeInTheDocument();
    expect(mockDatabaseTabRender).toHaveBeenCalledTimes(1);
    expect(capturedDatabaseTabProps).toEqual({ loadEmbeddingQueue: null });
  });
});
