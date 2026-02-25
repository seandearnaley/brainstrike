import { Check, Minus } from 'lucide-react';
import * as React from 'react';
import { cn } from './lib/utils';

export type CheckedState = boolean | 'indeterminate';

export interface LightweightCheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange'> {
  checked?: CheckedState;
  className?: string;
  onCheckedChange?: (checked: CheckedState) => void;
}

/**
 * A lightweight checkbox component optimized for large lists.
 * Visually identical to ShadCN checkbox but with minimal React component tree overhead.
 *
 * Key optimizations:
 * - No Radix UI context providers
 * - Direct DOM manipulation for state changes
 * - Minimal re-renders
 * - Maintains visual parity with ShadCN checkbox
 */
const LightweightCheckbox = ({
  className,
  checked = false,
  onCheckedChange,
  onClick,
  ref,
  ...props
}: LightweightCheckboxProps & { ref?: React.RefObject<HTMLInputElement | null> }) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const indicatorRef = React.useRef<HTMLDivElement>(null);

  // Combine refs
  React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLInputElement>) => {
      event.stopPropagation();

      if (props.disabled) {
        return;
      }

      const newChecked = checked !== true;
      onCheckedChange?.(newChecked);
      onClick?.(event);
    },
    [checked, onCheckedChange, onClick, props.disabled]
  );

  // Update input state for indeterminate and data-state attribute
  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    // Set indeterminate state (this can't be done via props)
    input.indeterminate = checked === 'indeterminate';

    // Set data-state attribute for compatibility with tests and styling
    if (checked === true) {
      input.setAttribute('data-state', 'checked');
    } else if (checked === 'indeterminate') {
      input.setAttribute('data-state', 'indeterminate');
    } else {
      input.setAttribute('data-state', 'unchecked');
    }
  }, [checked]);

  // Determine if checkbox should have primary background
  const shouldHavePrimaryBg = checked === true || checked === 'indeterminate';

  return (
    <div className="relative inline-flex items-center">
      <input
        checked={checked === true}
        className={cn(
          // Base styles matching ShadCN checkbox
          'peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'cursor-pointer',
          // Hide default checkbox appearance
          'appearance-none',
          // Apply primary background when checked or indeterminate
          shouldHavePrimaryBg ? 'bg-primary text-primary-foreground' : 'bg-background',
          className
        )}
        onChange={() => {}}
        onClick={handleClick}
        ref={inputRef} // Controlled by onClick
        type="checkbox"
        {...props}
      />

      {/* Visual indicator overlay */}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 flex items-center justify-center',
          'transition-opacity duration-150',
          // Use primary-foreground color when checked/indeterminate, otherwise transparent
          shouldHavePrimaryBg ? 'text-primary-foreground opacity-100' : 'opacity-0'
        )}
        ref={indicatorRef}
      >
        {checked === 'indeterminate' ? (
          <Minus className="h-4 w-4" />
        ) : checked === true ? (
          <Check className="h-4 w-4" />
        ) : null}
      </div>
    </div>
  );
};

LightweightCheckbox.displayName = 'LightweightCheckbox';

export { LightweightCheckbox };
