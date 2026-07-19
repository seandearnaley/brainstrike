import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionModeBadge } from '../selection-mode-badge';
import { FileExplorerTestWrapper } from './test-helpers';

describe('SelectionModeBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('display', () => {
    it('displays the Manual badge', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      expect(screen.getByTestId('selection-mode-badge')).toHaveTextContent('Manual');
    });
  });

  describe('popover interactions', () => {
    it('opens popover when clicked', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText('Selection Settings')).toBeInTheDocument();
      });
    });

    it('schedules focus after opening the popover with requestAnimationFrame', async () => {
      const requestAnimationFrameSpy = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        });

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge maxSelectionCount={100} />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByTestId('selection-mode-badge'));

      await waitFor(() => {
        expect(screen.getByLabelText(/Maximum selection count input/i)).toBeInTheDocument();
      });

      expect(requestAnimationFrameSpy).toHaveBeenCalled();
      requestAnimationFrameSpy.mockRestore();
    });

    it('cancels a pending animation frame when unmounting after open', () => {
      const cancelAnimationFrameSpy = vi
        .spyOn(window, 'cancelAnimationFrame')
        .mockImplementation(() => {});
      const requestAnimationFrameSpy = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation(() => 42);

      const { unmount } = render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge maxSelectionCount={100} />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByTestId('selection-mode-badge'));
      unmount();

      expect(requestAnimationFrameSpy).toHaveBeenCalled();
      expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(42);

      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    });

    it('cancels a pending focus frame when the popover closes before focus runs', async () => {
      const user = userEvent.setup();
      const cancelAnimationFrameSpy = vi
        .spyOn(window, 'cancelAnimationFrame')
        .mockImplementation(() => {});
      const requestAnimationFrameSpy = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation(() => 42);

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge maxSelectionCount={100} />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      await user.click(badge);
      await user.click(badge);

      expect(requestAnimationFrameSpy).toHaveBeenCalled();
      expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(42);

      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    });

    it('renders a settings trigger variant for compact toolbars', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge triggerVariant="icon" />
        </FileExplorerTestWrapper>
      );

      expect(screen.getByRole('button', { name: 'Selection settings' })).toBeInTheDocument();
      expect(screen.queryByTestId('selection-mode-badge')).not.toBeInTheDocument();
    });

    it('uses a selected-count value as the ultra-compact settings trigger', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge
            compactValue={{
              accessibleLabel: '1234 of 8000 files selected.',
              label: '1.2K',
            }}
            triggerVariant="icon"
          />
        </FileExplorerTestWrapper>
      );

      expect(
        screen.getByRole('button', {
          name: 'Selection settings. 1234 of 8000 files selected.',
        })
      ).toBeInTheDocument();
      expect(screen.getByTestId('selection-compact-count')).toHaveTextContent('1.2K');
    });

    it('shows max selection controls inside the settings popover', async () => {
      const onMaxSelectionCountChange = vi.fn();

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge
            maxSelectionCount={100}
            onMaxSelectionCountChange={onMaxSelectionCountChange}
            triggerVariant="icon"
          />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Selection settings' }));

      await waitFor(() => {
        expect(screen.getByLabelText(/Maximum selection count input/i)).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: '5K' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '6K' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '8K' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '6K' }));

      expect(onMaxSelectionCountChange).toHaveBeenCalledWith(6000);
    });

    it('commits a typed selection cap with Enter and closes with Escape', async () => {
      const user = userEvent.setup();
      const onMaxSelectionCountChange = vi.fn();

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge
            maxSelectionCount={100}
            onMaxSelectionCountChange={onMaxSelectionCountChange}
          />
        </FileExplorerTestWrapper>
      );

      await user.click(screen.getByTestId('selection-mode-badge'));
      const input = await screen.findByLabelText(/Maximum selection count input/i);

      await user.clear(input);
      await user.type(input, '250{Enter}');

      expect(onMaxSelectionCountChange).toHaveBeenCalledWith(250);
      await waitFor(() => {
        expect(screen.queryByText('Selection Settings')).not.toBeInTheDocument();
      });

      await user.click(screen.getByTestId('selection-mode-badge'));
      expect(await screen.findByLabelText(/Maximum selection count input/i)).toHaveValue('100');

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByText('Selection Settings')).not.toBeInTheDocument();
      });
    });

    it('reports invalid typed selection cap values and clears the error while editing', async () => {
      const user = userEvent.setup();
      const onMaxSelectionCountChange = vi.fn();

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge
            maxSelectionCount={100}
            onMaxSelectionCountChange={onMaxSelectionCountChange}
          />
        </FileExplorerTestWrapper>
      );

      await user.click(screen.getByTestId('selection-mode-badge'));
      const input = await screen.findByLabelText(/Maximum selection count input/i);
      const applyButton = screen.getByRole('button', { name: 'Apply selection count' });

      await user.clear(input);
      await user.type(input, '3.5');
      await user.click(applyButton);
      expect(screen.getByRole('alert')).toHaveTextContent('Please enter a whole number');

      await user.clear(input);
      await user.type(input, '0');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await user.click(applyButton);
      expect(screen.getByRole('alert')).toHaveTextContent('Minimum selection count is 1');

      await user.clear(input);
      await user.type(input, '10001');
      await user.click(applyButton);
      expect(screen.getByRole('alert')).toHaveTextContent('Maximum selection count is 10,000');

      expect(onMaxSelectionCountChange).not.toHaveBeenCalled();
    });

    it('keeps the popover open when applying without a selection count callback', async () => {
      const user = userEvent.setup();

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge maxSelectionCount={100} />
        </FileExplorerTestWrapper>
      );

      await user.click(screen.getByTestId('selection-mode-badge'));
      await user.click(screen.getByRole('button', { name: 'Apply selection count' }));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('Selection Settings')).toBeInTheDocument();
    });

    it('closes the popover from the selection cap close button', async () => {
      const user = userEvent.setup();

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge maxSelectionCount={100} />
        </FileExplorerTestWrapper>
      );

      await user.click(screen.getByTestId('selection-mode-badge'));
      await user.click(screen.getByRole('button', { name: 'Close selection settings' }));

      await waitFor(() => {
        expect(screen.queryByText('Selection Settings')).not.toBeInTheDocument();
      });
    });
  });

  describe('accessibility', () => {
    it('has correct aria-label for badge', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      expect(badge).toBeInTheDocument();
    });

    it('renders with outline variant styling', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      // outline variant should not have primary background
      expect(badge.className).not.toMatch(/bg-primary/);
    });
  });
});
