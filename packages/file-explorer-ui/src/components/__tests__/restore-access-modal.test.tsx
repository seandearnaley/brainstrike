import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RestoreAccessModal } from '../restore-access-modal';

describe('RestoreAccessModal', () => {
  const defaultProps = {
    isOpen: true,
    folderName: 'test-folder',
    variant: 'pending' as const,
    onRestore: vi.fn(),
    onDismiss: vi.fn(),
  };

  it('renders the modal when open', () => {
    render(<RestoreAccessModal {...defaultProps} />);

    expect(screen.getByText('Restore access to your last folder?')).toBeInTheDocument();
    expect(screen.getByText(/"test-folder"/)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<RestoreAccessModal {...defaultProps} isOpen={false} />);

    expect(screen.queryByText('Restore access to your last folder?')).not.toBeInTheDocument();
  });

  it('calls onRestore when restore button is clicked', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();

    render(<RestoreAccessModal {...defaultProps} onRestore={onRestore} />);

    await user.click(screen.getByRole('button', { name: 'Restore Access' }));

    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(<RestoreAccessModal {...defaultProps} onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: 'Maybe Later' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows "Restoring..." when isRestoring is true', () => {
    render(<RestoreAccessModal {...defaultProps} isRestoring={true} />);

    expect(screen.getByRole('button', { name: 'Restoring...' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restoring...' })).toBeDisabled();
  });

  describe('variant: denied', () => {
    it('shows denied copy and restore button', () => {
      render(<RestoreAccessModal {...defaultProps} variant="denied" />);

      expect(screen.getByText('Folder access was denied')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Restore Access' })).toBeInTheDocument();
    });
  });

  describe('variant: stale', () => {
    it('shows stale copy and hides restore button', () => {
      render(<RestoreAccessModal {...defaultProps} variant="stale" />);

      expect(screen.getByText('Stored folder is no longer accessible')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Restore Access' })).not.toBeInTheDocument();
      // The dismiss button shows "Close" in stale variant
      const buttons = screen.getAllByRole('button', { name: 'Close' });
      // There are two Close buttons: the dialog close icon (sr-only) and the dismiss button
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });
  });
});
