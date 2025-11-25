/**
 * Tests for FilterChip component
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { File } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { FilterChip } from '../collection-browser/filter-chip';

describe('FilterChip', () => {
  describe('rendering', () => {
    it('renders with label', () => {
      render(<FilterChip label="Files" active={false} onClick={() => {}} />);

      expect(screen.getByText('Files')).toBeInTheDocument();
    });

    it('renders with icon', () => {
      render(
        <FilterChip
          label="Files"
          active={false}
          onClick={() => {}}
          icon={<File data-testid="file-icon" className="h-3 w-3" />}
        />
      );

      expect(screen.getByTestId('file-icon')).toBeInTheDocument();
    });

    it('renders as button with type="button"', () => {
      render(<FilterChip label="Test" active={false} onClick={() => {}} />);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('type', 'button');
    });
  });

  describe('accessibility', () => {
    it('has aria-pressed=true when active', () => {
      render(<FilterChip label="Files" active={true} onClick={() => {}} />);

      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    });

    it('has aria-pressed=false when inactive', () => {
      render(<FilterChip label="Files" active={false} onClick={() => {}} />);

      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('styling', () => {
    it('applies active styling when active', () => {
      render(<FilterChip label="Files" active={true} onClick={() => {}} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-primary');
      expect(button).toHaveClass('text-primary-foreground');
    });

    it('applies inactive styling when not active', () => {
      render(<FilterChip label="Files" active={false} onClick={() => {}} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-muted');
      expect(button).toHaveClass('text-muted-foreground');
    });

    it('applies disabled styling when disabled', () => {
      render(<FilterChip label="Files" active={false} onClick={() => {}} disabled />);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
      expect(button).toHaveClass('disabled:opacity-50');
    });
  });

  describe('interaction', () => {
    it('calls onClick when clicked', () => {
      const handleClick = vi.fn();
      render(<FilterChip label="Files" active={false} onClick={handleClick} />);

      fireEvent.click(screen.getByRole('button'));

      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('does not call onClick when disabled', () => {
      const handleClick = vi.fn();
      render(<FilterChip label="Files" active={false} onClick={handleClick} disabled />);

      fireEvent.click(screen.getByRole('button'));

      expect(handleClick).not.toHaveBeenCalled();
    });
  });
});
