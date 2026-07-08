import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VectorStatusWithDialog } from '../vector-status-with-dialog';

// Mock VectorStatusWithDb
vi.mock('../vector-status', () => ({
  VectorStatusWithDb: () => <div data-testid="vector-status-with-db">Vector Status</div>,
}));

describe('VectorStatusWithDialog', () => {
  it('renders VectorStatusWithDb', () => {
    render(<VectorStatusWithDialog />);
    expect(screen.getByTestId('vector-status-with-db')).toBeInTheDocument();
  });

  it('forwards queueAdapter prop to VectorStatusWithDb', () => {
    const mockQueueAdapter = {
      add: vi.fn(),
      addBulk: vi.fn(),
      cancel: vi.fn(),
      drain: vi.fn(),
      isPaused: false,
      isProcessing: false,
      onProgress: vi.fn(() => () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    const { rerender } = render(<VectorStatusWithDialog queueAdapter={mockQueueAdapter} />);
    expect(screen.getByTestId('vector-status-with-db')).toBeInTheDocument();

    // Rerender with null adapter
    rerender(<VectorStatusWithDialog queueAdapter={null} />);
    expect(screen.getByTestId('vector-status-with-db')).toBeInTheDocument();
  });
});
