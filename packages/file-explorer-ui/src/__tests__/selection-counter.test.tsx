import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectionCounter } from '../selection-counter';

describe('SelectionCounter', () => {
  describe('read-only mode', () => {
    it('displays current selection count and max', () => {
      render(<SelectionCounter maxSelectionCount={100} selectedCount={5} />);

      expect(screen.getByTestId('selection-count')).toHaveTextContent('5');
      expect(screen.getByTestId('selection-max')).toHaveTextContent('100');
    });

    it('uses normal styling when under limit', () => {
      render(<SelectionCounter maxSelectionCount={100} selectedCount={50} />);

      const button = screen.getByTestId('selection-count').closest('button');
      expect(button).toHaveClass('text-sm');
      expect(button?.className).toMatch(/bg-background/);
    });

    it('uses destructive styling when at limit', () => {
      render(<SelectionCounter maxSelectionCount={10} selectedCount={10} />);

      const button = screen.getByTestId('selection-count').closest('button');
      expect(button?.className).toMatch(/bg-destructive/);
    });

    it('displays as output element for accessibility', () => {
      const { container } = render(<SelectionCounter maxSelectionCount={100} selectedCount={5} />);

      const output = container.querySelector('output');
      expect(output).toBeInTheDocument();
    });

    it('renders with correct test ids', () => {
      render(<SelectionCounter maxSelectionCount={100} selectedCount={5} />);

      expect(screen.getByTestId('selection-count')).toBeInTheDocument();
      expect(screen.getByTestId('selection-max')).toBeInTheDocument();
    });

    it('applies correct button styling', () => {
      const { container } = render(<SelectionCounter maxSelectionCount={100} selectedCount={5} />);

      const button = container.querySelector('button');
      expect(button).toHaveClass('text-sm');
      expect(button).toHaveClass('rounded-md');
      expect(button).toHaveClass('border');
    });
  });

  describe('editable mode', () => {
    it('opens popover when clicked', async () => {
      const onChange = vi.fn();
      render(
        <SelectionCounter
          maxSelectionCount={100}
          onMaxSelectionCountChange={onChange}
          selectedCount={5}
        />
      );

      const badge = screen.getByTestId('selection-count').closest('button');
      expect(badge).toBeInTheDocument();

      fireEvent.click(badge!);

      await waitFor(() => {
        expect(screen.getByLabelText(/Maximum selection count input/i)).toBeInTheDocument();
      });
    });

    it('allows changing max selection count via input', async () => {
      const onChange = vi.fn();
      render(
        <SelectionCounter
          maxSelectionCount={100}
          onMaxSelectionCountChange={onChange}
          selectedCount={5}
        />
      );

      // Open popover
      const badge = screen.getByTestId('selection-count').closest('button');
      fireEvent.click(badge!);

      // Wait for input to appear
      await waitFor(() => {
        expect(screen.getByLabelText(/Maximum selection count input/i)).toBeInTheDocument();
      });

      const input = screen.getByLabelText(/Maximum selection count input/i);
      fireEvent.change(input, { target: { value: '250' } });

      // Click apply button
      const applyButton = screen.getByLabelText(/Apply selection count/i);
      fireEvent.click(applyButton);

      expect(onChange).toHaveBeenCalledWith(250);
    });

    it('applies preset values when clicked', async () => {
      const onChange = vi.fn();
      render(
        <SelectionCounter
          maxSelectionCount={100}
          onMaxSelectionCountChange={onChange}
          selectedCount={5}
        />
      );

      // Open popover
      const badge = screen.getByTestId('selection-count').closest('button');
      fireEvent.click(badge!);

      // Wait for presets to appear
      await waitFor(() => {
        expect(screen.getByText('50')).toBeInTheDocument();
      });

      const preset50 = screen.getByText('50');
      fireEvent.click(preset50);

      expect(onChange).toHaveBeenCalledWith(50);
    });

    it('validates input and shows error for invalid values', async () => {
      const onChange = vi.fn();
      render(
        <SelectionCounter
          maxSelectionCount={100}
          onMaxSelectionCountChange={onChange}
          selectedCount={5}
        />
      );

      // Open popover
      const badge = screen.getByTestId('selection-count').closest('button');
      fireEvent.click(badge!);

      await waitFor(() => {
        expect(screen.getByLabelText(/Maximum selection count input/i)).toBeInTheDocument();
      });

      const input = screen.getByLabelText(/Maximum selection count input/i);
      fireEvent.change(input, { target: { value: 'invalid' } });

      const applyButton = screen.getByLabelText(/Apply selection count/i);
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(screen.getByText(/Enter a valid positive number/i)).toBeInTheDocument();
      });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('closes popover on cancel', async () => {
      const onChange = vi.fn();
      render(
        <SelectionCounter
          maxSelectionCount={100}
          onMaxSelectionCountChange={onChange}
          selectedCount={5}
        />
      );

      // Open popover
      const badge = screen.getByTestId('selection-count').closest('button');
      fireEvent.click(badge!);

      await waitFor(() => {
        expect(screen.getByLabelText(/Maximum selection count input/i)).toBeInTheDocument();
      });

      const cancelButton = screen.getByLabelText(/Cancel/i);
      fireEvent.click(cancelButton);

      await waitFor(() => {
        expect(screen.queryByLabelText(/Maximum selection count input/i)).not.toBeInTheDocument();
      });
    });

    it('shows pencil icon when editable', () => {
      const onChange = vi.fn();
      const { container } = render(
        <SelectionCounter
          maxSelectionCount={100}
          onMaxSelectionCountChange={onChange}
          selectedCount={5}
        />
      );

      // Find the pencil icon - it should be visible
      const pencilIcon = container.querySelector('.lucide-pencil');
      expect(pencilIcon).toBeInTheDocument();
      expect(pencilIcon).toHaveClass('text-muted-foreground');
    });

    it('hides file icon in compact mode', () => {
      const onChange = vi.fn();
      const { container } = render(
        <SelectionCounter
          compact
          maxSelectionCount={100}
          onMaxSelectionCountChange={onChange}
          selectedCount={5}
        />
      );

      // Files icon should not be present in compact mode
      const filesIcon = container.querySelector('.lucide-files');
      expect(filesIcon).not.toBeInTheDocument();
    });
  });
});
