import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parseCountInput, SelectionCounter } from '../selection-counter';

describe('parseCountInput', () => {
  it('returns valid positive integers', () => {
    expect(parseCountInput('10')).toBe(10);
    expect(parseCountInput('100')).toBe(100);
    expect(parseCountInput('1000')).toBe(1000);
  });

  it('handles leading and trailing whitespace', () => {
    expect(parseCountInput('  50  ')).toBe(50);
    expect(parseCountInput('\t25\n')).toBe(25);
    expect(parseCountInput('   100   ')).toBe(100);
  });

  it('returns null for empty strings', () => {
    expect(parseCountInput('')).toBe(null);
    expect(parseCountInput('   ')).toBe(null);
    expect(parseCountInput('\t\n')).toBe(null);
  });

  it('returns null for non-numeric input', () => {
    expect(parseCountInput('abc')).toBe(null);
    expect(parseCountInput('hello')).toBe(null);
    expect(parseCountInput('12abc')).toBe(null);
  });

  it('returns zero as a valid number (minimum validation happens separately)', () => {
    expect(parseCountInput('0')).toBe(0);
  });

  it('returns null for negative numbers', () => {
    expect(parseCountInput('-1')).toBe(null);
    expect(parseCountInput('-100')).toBe(null);
  });

  it('returns null for decimal numbers', () => {
    expect(parseCountInput('1.5')).toBe(null);
    expect(parseCountInput('100.5')).toBe(null);
    expect(parseCountInput('0.5')).toBe(null);
  });

  it('returns null for Infinity', () => {
    expect(parseCountInput('Infinity')).toBe(null);
    expect(parseCountInput('-Infinity')).toBe(null);
  });

  it('returns null for NaN', () => {
    expect(parseCountInput('NaN')).toBe(null);
  });

  it('handles edge case numbers correctly', () => {
    expect(parseCountInput('1')).toBe(1);
    expect(parseCountInput('10000')).toBe(10_000);
    expect(parseCountInput('999999')).toBe(999_999);
  });
});

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

    it('keeps the selected count visible in very narrow headers while preserving the full accessible value', () => {
      render(<SelectionCounter compact maxSelectionCount={100} selectedCount={5} />);

      expect(
        screen.getByRole('button', {
          name: '5 of 100 files selected. Selection count (read-only)',
        })
      ).toBeInTheDocument();
      expect(screen.getByTestId('selection-count-suffix')).toHaveClass('hidden', '@[96px]:inline');
    });

    it('compacts four-digit selected counts without losing the exact accessible value', () => {
      render(<SelectionCounter compact maxSelectionCount={8000} selectedCount={1234} />);

      expect(
        screen.getByRole('button', {
          name: '1234 of 8000 files selected. Selection count (read-only)',
        })
      ).toHaveClass('px-1', 'text-xs', '@[72px]:px-1.5', '@[72px]:text-sm', '@[96px]:px-2');
      expect(screen.getByTestId('selection-count')).toHaveTextContent('1.2K');
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
        expect(screen.getByText(/Please enter a whole number/i)).toBeInTheDocument();
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

    it('uses numeric input mode for mobile keyboards', async () => {
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
      expect(input).toHaveAttribute('inputMode', 'numeric');
    });

    it('closes popover on Escape key', async () => {
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
      fireEvent.keyDown(input, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByLabelText(/Maximum selection count input/i)).not.toBeInTheDocument();
      });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('submits value on Enter key', async () => {
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
      fireEvent.change(input, { target: { value: '75' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onChange).toHaveBeenCalledWith(75);
    });

    it('clears error message when user corrects invalid input', async () => {
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

      // Enter invalid value
      fireEvent.change(input, { target: { value: 'invalid' } });
      const applyButton = screen.getByLabelText(/Apply selection count/i);
      fireEvent.click(applyButton);

      // Error should appear
      await waitFor(() => {
        expect(screen.getByText(/Please enter a whole number/i)).toBeInTheDocument();
      });

      // Correct the input
      fireEvent.change(input, { target: { value: '50' } });

      // Error should disappear
      await waitFor(() => {
        expect(screen.queryByText(/Please enter a whole number/i)).not.toBeInTheDocument();
      });
    });

    it('shows minimum validation error', async () => {
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
      fireEvent.change(input, { target: { value: '0' } });

      const applyButton = screen.getByLabelText(/Apply selection count/i);
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(screen.getByText(/Minimum selection count is 1/i)).toBeInTheDocument();
      });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('shows maximum validation error with formatted number', async () => {
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
      fireEvent.change(input, { target: { value: '50000' } });

      const applyButton = screen.getByLabelText(/Apply selection count/i);
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(screen.getByText(/Maximum selection count is 10,000/i)).toBeInTheDocument();
      });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('has accessible error messages with aria-live', async () => {
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
      fireEvent.change(input, { target: { value: 'abc' } });

      const applyButton = screen.getByLabelText(/Apply selection count/i);
      fireEvent.click(applyButton);

      await waitFor(() => {
        const errorElement = screen.getByRole('alert');
        expect(errorElement).toBeInTheDocument();
        expect(errorElement).toHaveAttribute('aria-live', 'polite');
        expect(errorElement).toHaveTextContent(/Please enter a whole number/i);
      });
    });
  });
});
