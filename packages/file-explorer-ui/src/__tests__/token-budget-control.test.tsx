import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TokenBudgetControl } from '../indexing/token-budget-control';

vi.mock('lucide-react', () => ({
  Check: () => <span data-testid="check-icon" />,
  Pencil: () => <span data-testid="pencil-icon" />,
  Target: () => <span data-testid="target-icon" />,
  X: () => <span data-testid="x-icon" />,
}));

vi.mock('@brainstrike/ui', async () => {
  const React = await import('react');

  interface GenericProps {
    children?: React.ReactNode;
    [key: string]: unknown;
  }

  interface ButtonProps {
    children: React.ReactNode;
    disabled?: boolean | undefined;
    onClick?: (() => void) | undefined;
    [key: string]: unknown;
  }

  type InputProps = React.ComponentPropsWithoutRef<'input'>;

  type PopoverProps = GenericProps & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  };

  const PopoverContext = React.createContext<{
    open: boolean;
    setOpen: (open: boolean) => void;
  }>({ open: false, setOpen: () => {} });

  return {
    Button: ({ children, onClick, disabled, ...props }: ButtonProps) => (
      <button disabled={disabled} onClick={onClick} type="button" {...props}>
        {children}
      </button>
    ),
    Input: React.forwardRef<HTMLInputElement, InputProps>((props, ref) => (
      <input ref={ref} {...props} />
    )),
    Popover: ({ children, open: controlledOpen, onOpenChange }: PopoverProps) => {
      const [open, setOpenState] = React.useState(controlledOpen ?? false);

      React.useEffect(() => {
        if (controlledOpen !== undefined) {
          setOpenState(controlledOpen);
        }
      }, [controlledOpen]);

      const setOpen = (value: boolean) => {
        setOpenState(value);
        onOpenChange?.(value);
      };

      return (
        <PopoverContext.Provider value={{ open, setOpen }}>{children}</PopoverContext.Provider>
      );
    },
    PopoverContent: ({ children, ...props }: GenericProps) => {
      const { open } = React.useContext(PopoverContext);
      return open ? <div {...props}>{children}</div> : null;
    },
    PopoverTrigger: ({ children, asChild: _asChild, ...props }: GenericProps) => {
      const { setOpen, open } = React.useContext(PopoverContext);
      return (
        <button {...props} onClick={() => setOpen(!open)} type="button">
          {children}
        </button>
      );
    },
    Tooltip: ({ children }: GenericProps) => <>{children}</>,
    TooltipContent: ({ children }: GenericProps) => <div>{children}</div>,
    TooltipProvider: ({ children }: GenericProps) => <>{children}</>,
    TooltipTrigger: ({ children, asChild: _asChild, ...props }: GenericProps) => (
      <div {...props}>{children}</div>
    ),
  };
});

describe('TokenBudgetControl', () => {
  it('renders read-only when onBudgetChange is not provided', () => {
    render(<TokenBudgetControl budget={100_000} />);

    // Should show the formatted budget value
    expect(screen.getByText('100,000')).toBeVisible();
    // Should not have an edit pencil icon visible (it's a read-only trigger)
    expect(screen.queryByTestId('pencil-icon')).not.toBeInTheDocument();
  });

  it('shows editable trigger with pencil when onBudgetChange is provided', () => {
    const onBudgetChange = vi.fn();
    render(<TokenBudgetControl budget={100_000} onBudgetChange={onBudgetChange} />);

    // Should show the formatted budget value
    expect(screen.getByText('100,000')).toBeVisible();
    // Should show target icon
    expect(screen.getByTestId('target-icon')).toBeInTheDocument();
  });

  it('opens popover and shows input when clicked', () => {
    const onBudgetChange = vi.fn();
    render(<TokenBudgetControl budget={100_000} onBudgetChange={onBudgetChange} />);

    // Click the trigger button to open popover
    const trigger = screen.getByRole('button', { name: /click to edit token budget/i });
    fireEvent.click(trigger);

    // Should show input
    expect(screen.getByLabelText(/token budget input/i)).toBeInTheDocument();
    // Should show preset buttons
    expect(screen.getByRole('button', { name: '32K' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '100K' })).toBeInTheDocument();
  });

  it('parses human-friendly inputs and calls onBudgetChange', async () => {
    const onBudgetChange = vi.fn();
    render(<TokenBudgetControl budget={100_000} onBudgetChange={onBudgetChange} />);

    // Click to open popover
    const trigger = screen.getByRole('button', { name: /click to edit token budget/i });
    fireEvent.click(trigger);

    // Change the input value
    const input = screen.getByLabelText(/token budget input/i);
    fireEvent.change(input, { target: { value: '250k tokens' } });

    // Press Enter to commit
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onBudgetChange).toHaveBeenCalledWith(250_000);
  });

  it('applies preset values when clicking preset buttons', () => {
    const onBudgetChange = vi.fn();
    render(<TokenBudgetControl budget={100_000} onBudgetChange={onBudgetChange} />);

    // Click to open popover
    const trigger = screen.getByRole('button', { name: /click to edit token budget/i });
    fireEvent.click(trigger);

    // Click a preset button
    const preset64K = screen.getByRole('button', { name: '64K' });
    fireEvent.click(preset64K);

    expect(onBudgetChange).toHaveBeenCalledWith(64_000);
  });

  it('shows an error for invalid input', () => {
    const onBudgetChange = vi.fn();
    render(<TokenBudgetControl budget={100_000} onBudgetChange={onBudgetChange} />);

    // Click to open popover
    const trigger = screen.getByRole('button', { name: /click to edit token budget/i });
    fireEvent.click(trigger);

    // Change to invalid value
    const input = screen.getByLabelText(/token budget input/i);
    fireEvent.change(input, { target: { value: 'nope' } });

    // Click apply button
    const applyButton = screen.getByRole('button', { name: /apply budget/i });
    fireEvent.click(applyButton);

    expect(onBudgetChange).not.toHaveBeenCalled();
    expect(screen.getByText(/enter a valid number/i)).toBeInTheDocument();
  });

  it('closes popover on Escape key', () => {
    const onBudgetChange = vi.fn();
    render(<TokenBudgetControl budget={100_000} onBudgetChange={onBudgetChange} />);

    // Click to open popover
    const trigger = screen.getByRole('button', { name: /click to edit token budget/i });
    fireEvent.click(trigger);

    // Verify popover is open
    expect(screen.getByLabelText(/token budget input/i)).toBeInTheDocument();

    // Press Escape
    const input = screen.getByLabelText(/token budget input/i);
    fireEvent.keyDown(input, { key: 'Escape' });

    // Popover should close
    expect(screen.queryByLabelText(/token budget input/i)).not.toBeInTheDocument();
  });

  it('shows compact format when compact prop is true', () => {
    render(<TokenBudgetControl budget={100_000} compact />);

    // Should show compact "100K" instead of "100,000"
    expect(screen.getByText('100K')).toBeVisible();
  });

  it('shows an error when value exceeds maximum budget', () => {
    const onBudgetChange = vi.fn();
    render(<TokenBudgetControl budget={100_000} onBudgetChange={onBudgetChange} />);

    // Click to open popover
    const trigger = screen.getByRole('button', { name: /click to edit token budget/i });
    fireEvent.click(trigger);

    // Change to a value exceeding MAX_TOKEN_BUDGET (100,000,000)
    const input = screen.getByLabelText(/token budget input/i);
    fireEvent.change(input, { target: { value: '200b' } }); // 200 billion

    // Click apply button
    const applyButton = screen.getByRole('button', { name: /apply budget/i });
    fireEvent.click(applyButton);

    expect(onBudgetChange).not.toHaveBeenCalled();
    expect(screen.getByText(/maximum budget is/i)).toBeInTheDocument();
  });
});
