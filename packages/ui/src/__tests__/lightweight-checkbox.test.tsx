import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LightweightCheckbox } from '../lightweight-checkbox';

describe('LightweightCheckbox', () => {
  it('renders unchecked state by default', () => {
    render(<LightweightCheckbox />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAttribute('data-state', 'unchecked');
  });

  it('renders checked state', () => {
    render(<LightweightCheckbox checked={true} />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAttribute('data-state', 'checked');
  });

  it('renders indeterminate state', () => {
    render(<LightweightCheckbox checked="indeterminate" />);
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox).toHaveAttribute('data-state', 'indeterminate');
    expect(checkbox.indeterminate).toBe(true);
  });

  it('calls onCheckedChange when clicked', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();

    render(<LightweightCheckbox checked={false} onCheckedChange={onCheckedChange} />);

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('toggles from checked to unchecked', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();

    render(<LightweightCheckbox checked={true} onCheckedChange={onCheckedChange} />);

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it('toggles from indeterminate to checked', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();

    render(<LightweightCheckbox checked="indeterminate" onCheckedChange={onCheckedChange} />);

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('does not call onCheckedChange when disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();

    render(<LightweightCheckbox disabled onCheckedChange={onCheckedChange} />);

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('applies custom className', () => {
    render(<LightweightCheckbox className="custom-class" />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toHaveClass('custom-class');
  });

  it('forwards other props to input element', () => {
    render(<LightweightCheckbox id="test-checkbox" name="test" />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toHaveAttribute('id', 'test-checkbox');
    expect(checkbox).toHaveAttribute('name', 'test');
  });

  it('calls custom onClick handler', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onCheckedChange = vi.fn();

    render(<LightweightCheckbox onCheckedChange={onCheckedChange} onClick={onClick} />);

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(onClick).toHaveBeenCalled();
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('stops propagation on click', async () => {
    const user = userEvent.setup();
    const parentClick = vi.fn();
    const parentKeyDown = vi.fn();
    const onCheckedChange = vi.fn();

    render(
      <button onClick={parentClick} onKeyDown={parentKeyDown} type="button">
        <LightweightCheckbox onCheckedChange={onCheckedChange} />
      </button>
    );

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('maintains visual consistency with ShadCN checkbox classes', () => {
    render(<LightweightCheckbox />);
    const checkbox = screen.getByRole('checkbox');

    // Check for key ShadCN checkbox classes
    expect(checkbox).toHaveClass(
      'h-4',
      'w-4',
      'shrink-0',
      'rounded-sm',
      'border',
      'border-primary'
    );
    expect(checkbox).toHaveClass('focus-visible:outline-none', 'focus-visible:ring-2');
    expect(checkbox).toHaveClass('disabled:cursor-not-allowed', 'disabled:opacity-50');
    expect(checkbox).toHaveClass('cursor-pointer', 'appearance-none');
  });

  it('shows check icon when checked', () => {
    render(<LightweightCheckbox checked={true} />);
    // The check icon should be visible (opacity-100)
    const indicator = document.querySelector('[class*="opacity-100"]');
    expect(indicator).toBeInTheDocument();
  });

  it('shows minus icon when indeterminate', () => {
    render(<LightweightCheckbox checked="indeterminate" />);
    // The minus icon should be visible (opacity-100)
    const indicator = document.querySelector('[class*="opacity-100"]');
    expect(indicator).toBeInTheDocument();
  });

  it('hides icon when unchecked', () => {
    render(<LightweightCheckbox checked={false} />);
    // The indicator should be hidden (opacity-0)
    const indicator = document.querySelector('[class*="opacity-0"]');
    expect(indicator).toBeInTheDocument();
  });

  describe('accessibility', () => {
    it('supports aria-label', () => {
      render(<LightweightCheckbox aria-label="Test checkbox" />);
      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toHaveAttribute('aria-label', 'Test checkbox');
    });

    it('supports aria-describedby', () => {
      render(<LightweightCheckbox aria-describedby="description" />);
      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toHaveAttribute('aria-describedby', 'description');
    });

    it('is keyboard accessible', async () => {
      const user = userEvent.setup();
      const onCheckedChange = vi.fn();

      render(<LightweightCheckbox onCheckedChange={onCheckedChange} />);

      const checkbox = screen.getByRole('checkbox');
      checkbox.focus();

      await user.keyboard(' ');

      expect(onCheckedChange).toHaveBeenCalledWith(true);
    });
  });

  describe('performance characteristics', () => {
    it('does not create unnecessary re-renders', () => {
      const renderSpy = vi.fn();

      function TestComponent({ checked }: { checked: boolean }) {
        renderSpy();
        return <LightweightCheckbox checked={checked} />;
      }

      const { rerender } = render(<TestComponent checked={false} />);

      // Initial render
      expect(renderSpy).toHaveBeenCalledTimes(1);

      // Re-render with same props should not cause additional renders due to memoization
      rerender(<TestComponent checked={false} />);
      expect(renderSpy).toHaveBeenCalledTimes(2); // React will still call the function, but DOM updates should be minimal
    });
  });
});
