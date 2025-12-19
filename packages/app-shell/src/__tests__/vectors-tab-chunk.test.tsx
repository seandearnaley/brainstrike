import type { QueueAdapter } from '@brainstrike/queue';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VectorsTab } from '../vectors-tab-chunk';

let capturedVectorStatusProps: { queueAdapter?: QueueAdapter | null } | null = null;

vi.mock('@brainstrike/vector-management', () => ({
  VectorStatusWithDialog: (props: { queueAdapter?: QueueAdapter | null }) => {
    capturedVectorStatusProps = props;
    return <div data-testid="vector-status-with-dialog">VectorStatusWithDialog</div>;
  },
}));

describe('VectorsTab (chunk)', () => {
  beforeEach(() => {
    capturedVectorStatusProps = null;
  });

  it('renders VectorStatusWithDialog', () => {
    const { getByTestId } = render(<VectorsTab />);

    expect(getByTestId('vector-status-with-dialog')).toBeInTheDocument();
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

    render(<VectorsTab embeddingQueue={mockQueue} />);

    expect(capturedVectorStatusProps).not.toBeNull();
    expect(capturedVectorStatusProps?.queueAdapter).toBe(mockQueue);
  });

  it('passes null when no embeddingQueue is provided', () => {
    render(<VectorsTab />);

    expect(capturedVectorStatusProps).not.toBeNull();
    expect(capturedVectorStatusProps?.queueAdapter).toBeNull();
  });
});
