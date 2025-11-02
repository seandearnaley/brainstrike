import type { QueueAdapter } from '@brainstrike/queue';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseTab } from '../database-tab-chunk';

// Track props passed to VectorStatusWithDialog
let capturedVectorStatusProps: { queueAdapter?: QueueAdapter | null } | null = null;

// Mock dependencies
vi.mock('@brainstrike/db-explorer', () => ({
  DatabaseDemoPanel: () => <div data-testid="database-demo-panel">DatabaseDemoPanel</div>,
}));

vi.mock('@brainstrike/vector-management', () => ({
  VectorStatusWithDialog: (props: { queueAdapter?: QueueAdapter | null }) => {
    capturedVectorStatusProps = props;
    return <div data-testid="vector-status-with-dialog">VectorStatusWithDialog</div>;
  },
  QueueHud: () => <div data-testid="queue-hud">QueueHud</div>,
}));

describe('DatabaseTab (chunk)', () => {
  beforeEach(() => {
    capturedVectorStatusProps = null;
  });

  it('renders DatabaseDemoPanel, VectorStatusWithDialog, and QueueHud', () => {
    const { getByTestId } = render(<DatabaseTab />);

    expect(getByTestId('database-demo-panel')).toBeInTheDocument();
    expect(getByTestId('vector-status-with-dialog')).toBeInTheDocument();
    expect(getByTestId('queue-hud')).toBeInTheDocument();
  });

  it('uses VectorStatusWithDialog (which includes manage button functionality)', () => {
    const { getByTestId, queryByTestId } = render(<DatabaseTab />);

    // Should render VectorStatusWithDialog (with database access + manage button)
    expect(getByTestId('vector-status-with-dialog')).toBeInTheDocument();

    // Should NOT render the simplified VectorStatus component
    // This prevents regression where VectorStatus always shows "pgvector: off"
    expect(queryByTestId('vector-status')).not.toBeInTheDocument();
  });

  it('passes embeddingQueue prop to VectorStatusWithDialog as queueAdapter', () => {
    const mockQueue = {
      add: vi.fn(),
      addBulk: vi.fn(),
      onProgress: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      drain: vi.fn(),
    } as unknown as QueueAdapter;

    render(<DatabaseTab embeddingQueue={mockQueue} />);

    expect(capturedVectorStatusProps).not.toBeNull();
    expect(capturedVectorStatusProps?.queueAdapter).toBe(mockQueue);
  });

  it('passes null when no embeddingQueue is provided', () => {
    render(<DatabaseTab />);

    expect(capturedVectorStatusProps).not.toBeNull();
    expect(capturedVectorStatusProps?.queueAdapter).toBeNull();
  });

  it('CRITICAL: prevents regression where embeddingQueue is lost', () => {
    // This test ensures the manage button functionality works
    // by verifying the queue prop flows through correctly
    const mockQueue = {
      add: vi.fn(),
      addBulk: vi.fn(),
      onProgress: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      drain: vi.fn(),
    } as unknown as QueueAdapter;

    render(<DatabaseTab embeddingQueue={mockQueue} />);

    // CRITICAL: VectorStatusWithDialog MUST receive the queueAdapter prop
    // Otherwise, the manage button won't work because it won't have the proper queue context
    expect(capturedVectorStatusProps?.queueAdapter).toBe(mockQueue);
  });
});
