import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VectorStatusWithDialog } from '../vector-status-with-dialog';

// Mock the dependencies
vi.mock('../vector-status', () => ({
  VectorStatusWithDb: ({ onManageEmbeddingSets }: { onManageEmbeddingSets?: () => void }) => (
    <div data-testid="vector-status-with-db">
      <button type="button" onClick={onManageEmbeddingSets}>
        Manage
      </button>
    </div>
  ),
}));

vi.mock('../embedding-set-management', () => ({
  ManageEmbeddingSetsDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="manage-dialog">
        <button type="button" onClick={() => onOpenChange(false)}>
          Close
        </button>
      </div>
    ) : null,
}));

describe('VectorStatusWithDialog', () => {
  it('renders VectorStatusWithDb', () => {
    render(<VectorStatusWithDialog />);
    expect(screen.getByTestId('vector-status-with-db')).toBeInTheDocument();
  });

  it('opens dialog when onManageEmbeddingSets is called', () => {
    render(<VectorStatusWithDialog />);

    // Dialog should not be visible initially
    expect(screen.queryByTestId('manage-dialog')).not.toBeInTheDocument();

    // Click the Manage button
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));

    // Dialog should now be visible
    expect(screen.getByTestId('manage-dialog')).toBeInTheDocument();
  });

  it('closes dialog when onOpenChange is called', () => {
    render(<VectorStatusWithDialog />);

    // Open the dialog
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(screen.getByTestId('manage-dialog')).toBeInTheDocument();

    // Close the dialog
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // Dialog should be closed
    expect(screen.queryByTestId('manage-dialog')).not.toBeInTheDocument();
  });
});
