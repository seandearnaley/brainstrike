import type { QueueAdapter } from '@brainstrike/queue';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseTab } from '../database-tab-chunk';

let capturedDatabaseProps: { embeddingQueue?: QueueAdapter | null } | null = null;

// Mock dependencies
vi.mock('@brainstrike/db-explorer/database-demo-panel', () => ({
  DatabaseDemoPanel: (props: { embeddingQueue?: QueueAdapter | null }) => {
    capturedDatabaseProps = props;
    return <div data-testid="database-demo-panel">DatabaseDemoPanel</div>;
  },
}));

describe('DatabaseTab (chunk)', () => {
  beforeEach(() => {
    capturedDatabaseProps = null;
  });

  it('renders DatabaseDemoPanel', () => {
    const { getByTestId } = render(<DatabaseTab />);

    expect(getByTestId('database-demo-panel')).toBeInTheDocument();
  });

  it('passes embeddingQueue prop to DatabaseDemoPanel', () => {
    const mockQueue = {
      add: vi.fn(),
      addBulk: vi.fn(),
      drain: vi.fn(),
      onProgress: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as QueueAdapter;

    render(<DatabaseTab embeddingQueue={mockQueue} />);

    expect(capturedDatabaseProps).not.toBeNull();
    expect(capturedDatabaseProps?.embeddingQueue).toBe(mockQueue);
  });

  it('passes null when no embeddingQueue is provided', () => {
    render(<DatabaseTab />);

    expect(capturedDatabaseProps).not.toBeNull();
    expect(capturedDatabaseProps?.embeddingQueue).toBeNull();
  });
});
