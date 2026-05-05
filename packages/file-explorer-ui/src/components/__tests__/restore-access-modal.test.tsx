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
    onChooseDifferentFolder: vi.fn(),
  };

  it('renders the modal when open', () => {
    render(<RestoreAccessModal {...defaultProps} />);

    expect(screen.getByText('Restore access to your last folder?')).toBeInTheDocument();
    expect(screen.getByText(/"test-folder"/)).toBeInTheDocument();
  });

  it('stacks modal content above the overlay so Restore Access stays clickable', () => {
    render(<RestoreAccessModal {...defaultProps} />);

    const surface = screen.getByRole('alertdialog');
    expect(surface.className).toContain('z-[51]');
  });

  it('does not render when closed', () => {
    render(<RestoreAccessModal {...defaultProps} isOpen={false} />);

    expect(screen.queryByText('Restore access to your last folder?')).not.toBeInTheDocument();
  });

  it('calls onRestore when restore button is clicked', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();

    render(<RestoreAccessModal {...defaultProps} onRestore={onRestore} />);

    await user.click(screen.getByRole('button', { name: 'Restore folder access' }));

    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(<RestoreAccessModal {...defaultProps} onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: 'Dismiss and restore later' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onChooseDifferentFolder from the modal action', async () => {
    const user = userEvent.setup();
    const onChooseDifferentFolder = vi.fn();

    render(
      <RestoreAccessModal {...defaultProps} onChooseDifferentFolder={onChooseDifferentFolder} />
    );

    await user.click(screen.getByRole('button', { name: 'Choose different folder' }));

    expect(onChooseDifferentFolder).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when escape key is pressed', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(<RestoreAccessModal {...defaultProps} onDismiss={onDismiss} />);

    await user.keyboard('{Escape}');

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows "Restoring..." when isRestoring is true', () => {
    render(<RestoreAccessModal {...defaultProps} isRestoring={true} />);

    expect(screen.getByRole('button', { name: 'Restoring folder access' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restoring folder access' })).toBeDisabled();
  });

  describe('variant: denied', () => {
    it('shows denied copy and restore button', () => {
      render(<RestoreAccessModal {...defaultProps} variant="denied" />);

      expect(screen.getByText('Folder access was denied')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Restore folder access' })).toBeInTheDocument();
    });
  });

  describe('variant: stale', () => {
    it('shows stale copy and hides restore button', () => {
      render(<RestoreAccessModal {...defaultProps} variant="stale" />);

      expect(screen.getByText('Stored folder is no longer accessible')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Restore folder access' })
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose different folder' })).toBeInTheDocument();
      // The dismiss button shows "Close" in stale variant
      expect(screen.getByRole('button', { name: 'Close dialog' })).toBeInTheDocument();
    });
  });
});
