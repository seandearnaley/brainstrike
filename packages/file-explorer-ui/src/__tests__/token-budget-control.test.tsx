import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TokenBudgetControl } from '../token-budget-control';

vi.mock('lucide-react', () => ({
  Check: () => null,
  Pencil: () => null,
  X: () => null,
}));

vi.mock('@brainstrike/ui', async () => {
  const React = await import('react');

  type BadgeProps = {
    children: React.ReactNode;
    [key: string]: unknown;
  };

  type ButtonProps = {
    children: React.ReactNode;
    onClick?: (() => void) | undefined;
    disabled?: boolean | undefined;
    [key: string]: unknown;
  };

  type InputProps = React.ComponentPropsWithoutRef<'input'>;

  return {
    Badge: ({ children, ...props }: BadgeProps) => (
      <div data-testid="badge" {...props}>
        {children}
      </div>
    ),
    Button: ({ children, onClick, disabled, ...props }: ButtonProps) => (
      <button disabled={disabled} onClick={onClick} type="button" {...props}>
        {children}
      </button>
    ),
    Input: React.forwardRef<HTMLInputElement, InputProps>((props, ref) => (
      <input ref={ref} {...props} />
    )),
  };
});

describe('TokenBudgetControl', () => {
  it('renders read-only when onBudgetChange is not provided', () => {
    render(<TokenBudgetControl budget={100_000} />);

    expect(screen.getByText('Budget')).toBeVisible();
    expect(screen.getByText('100,000')).toBeVisible();
    expect(screen.queryByRole('button', { name: /edit token budget/i })).toBeNull();
  });

  it('parses human-friendly inputs and calls onBudgetChange', () => {
    const onBudgetChange = vi.fn();
    render(<TokenBudgetControl budget={100_000} onBudgetChange={onBudgetChange} />);

    fireEvent.click(screen.getByRole('button', { name: /edit token budget/i }));
    const input = screen.getByLabelText(/token budget input/i);

    fireEvent.change(input, { target: { value: '250k tokens' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onBudgetChange).toHaveBeenCalledWith(250_000);
    expect(screen.queryByLabelText(/token budget input/i)).toBeNull();
  });

  it('shows an error for invalid input and allows cancel', () => {
    const onBudgetChange = vi.fn();
    render(<TokenBudgetControl budget={100_000} onBudgetChange={onBudgetChange} />);

    fireEvent.click(screen.getByRole('button', { name: /edit token budget/i }));
    const input = screen.getByLabelText(/token budget input/i);

    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /save token budget/i }));

    expect(onBudgetChange).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a valid token budget')).toBeVisible();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('Enter a valid token budget')).toBeNull();
    expect(screen.queryByLabelText(/token budget input/i)).toBeNull();
  });
});
