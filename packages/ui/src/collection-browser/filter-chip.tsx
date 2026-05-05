/**
 * FilterChip Component
 *
 * A small pill-shaped button used for toggling filter states.
 * Used in the FilterBar for node type and status filters.
 */

import * as React from 'react';
import { cn } from '../lib/utils';
import type { FilterChipProps } from './types';

/**
 * FilterChip - A toggleable filter button
 *
 * @example
 * ```tsx
 * <FilterChip
 *   label="Files"
 *   active={showFiles}
 *   onClick={() => setShowFiles(!showFiles)}
 *   icon={<File className="h-3 w-3" />}
 * />
 * ```
 */
export const FilterChip = React.memo(function FilterChip({
  label,
  active,
  onClick,
  icon,
  disabled = false,
  className,
}: FilterChipProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-xs',
        'transition-colors duration-150',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/80',
        className
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
});

FilterChip.displayName = 'FilterChip';

export default FilterChip;
