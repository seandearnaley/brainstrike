import { MAX_SELECTION_COUNT, MIN_MAX_SELECTION_COUNT } from '@brainstrike/types';
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Check, Files, Pencil, X } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { formatCompactSelectionCount } from './selection-count-format';

/**
 * Parses user input for selection count validation.
 * Rejects empty strings, non-numeric input, decimals, zero, negative numbers, and non-finite values.
 * @param raw - The raw string input from the user
 * @returns The parsed positive integer, or null if invalid
 */
export function parseCountInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  // Explicitly reject decimal numbers
  if (trimmed.includes('.')) {
    return null;
  }

  // Validate that the entire string is numeric
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
}

// Quick selection presets stay dense at small counts, then jump to the larger
// context-size caps requested for the explorer workflow (5K/6K/8K).
export const SELECTION_PRESETS = [
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: '250', value: 250 },
  { label: '500', value: 500 },
  { label: '1K', value: 1000 },
  { label: '2K', value: 2000 },
  { label: '3K', value: 3000 },
  { label: '5K', value: 5000 },
  { label: '6K', value: 6000 },
  { label: '8K', value: 8000 },
] as const;

export interface SelectionCounterProps {
  /** Compact mode for smaller layouts */
  compact?: boolean;
  maxSelectionCount: number;
  onMaxSelectionCountChange?: ((count: number) => void) | undefined;
  selectedCount: number;
}

export const SelectionCounter = memo<SelectionCounterProps>(function SelectionCounter({
  selectedCount,
  maxSelectionCount,
  onMaxSelectionCountChange,
  compact = false,
}) {
  const isEditable = typeof onMaxSelectionCountChange === 'function';
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isAtLimit = selectedCount >= maxSelectionCount;
  const isNearLimit = selectedCount >= maxSelectionCount * 0.9;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        // Initialize draft with current max count when opening
        setDraft(String(maxSelectionCount));
        setError(null);
        // Focus and select input after render
        queueMicrotask(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    },
    [maxSelectionCount]
  );

  const commit = useCallback(() => {
    if (typeof onMaxSelectionCountChange !== 'function') {
      setIsOpen(false);
      return;
    }

    const parsed = parseCountInput(draft);
    if (parsed === null) {
      setError('Please enter a whole number (no decimals)');
      return;
    }

    if (parsed < MIN_MAX_SELECTION_COUNT) {
      setError(`Minimum selection count is ${MIN_MAX_SELECTION_COUNT}`);
      return;
    }

    if (parsed > MAX_SELECTION_COUNT) {
      setError(`Maximum selection count is ${MAX_SELECTION_COUNT.toLocaleString()}`);
      return;
    }

    onMaxSelectionCountChange(parsed);
    setIsOpen(false);
  }, [draft, onMaxSelectionCountChange]);

  const applyPreset = useCallback(
    (value: number) => {
      if (typeof onMaxSelectionCountChange === 'function') {
        onMaxSelectionCountChange(value);
        setIsOpen(false);
      }
    },
    [onMaxSelectionCountChange]
  );

  const tooltipLabel = useMemo(() => {
    if (!isEditable) {
      return 'Selection count (read-only)';
    }
    return 'Click to edit maximum selection count';
  }, [isEditable]);
  const accessibleLabel = `${selectedCount} of ${maxSelectionCount} files selected. ${tooltipLabel}`;
  const visibleSelectedCount = compact
    ? formatCompactSelectionCount(selectedCount)
    : String(selectedCount);

  // Dynamic styling based on selection status
  const statusStyles = useMemo(() => {
    if (isAtLimit) {
      return 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15';
    }
    if (isNearLimit) {
      return 'bg-primary/10 text-primary border-primary/20 hover:bg-primary/15';
    }
    return 'bg-background text-foreground border-border hover:bg-accent';
  }, [isAtLimit, isNearLimit]);

  const triggerButton = (
    <button
      aria-label={accessibleLabel}
      className={`flex @[300px]:h-9 h-8 items-center @[300px]:gap-1.5 gap-1 rounded-md border @[300px]:px-2.5 ${
        compact ? '@[72px]:px-1.5 @[96px]:px-2 px-1 @[72px]:text-sm text-xs' : 'px-2 text-sm'
      } py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${statusStyles} ${
        isEditable ? 'cursor-pointer' : 'cursor-default'
      }`}
      disabled={!isEditable}
      onClick={() => isEditable && handleOpenChange(true)}
      type="button"
    >
      {!compact && <Files className="@[300px]:mr-2 size-3.5 text-muted-foreground" />}
      <span className="font-medium tabular-nums">
        <span data-testid="selection-count">{visibleSelectedCount}</span>
        <span
          className={compact ? '@[96px]:inline hidden' : undefined}
          data-testid="selection-count-suffix"
        >
          <span className="mx-0.5">/</span>
          <span data-testid="selection-max">{maxSelectionCount}</span>
        </span>
      </span>
      {isEditable && (
        <Pencil className="@[300px]:ml-2 @[300px]:inline hidden size-3 text-muted-foreground" />
      )}
    </button>
  );

  if (!isEditable) {
    return (
      <output>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
            <TooltipContent side="bottom">
              <div className="text-xs">
                <div className="font-medium">Selection Count</div>
                <div className="text-muted-foreground">
                  {selectedCount} of {maxSelectionCount} files selected (read-only)
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </output>
    );
  }

  return (
    <output>
      <Popover onOpenChange={handleOpenChange} open={isOpen}>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
            </TooltipTrigger>
            {!isOpen && (
              <TooltipContent side="bottom">
                <div className="text-xs">Click to edit max selection count</div>
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
        <PopoverContent align="end" className="w-64 p-3" side="bottom">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="font-medium text-foreground text-xs" htmlFor="max-count-input">
                Maximum Selection Count
              </label>
              <div className="flex gap-1.5">
                <Input
                  aria-label="Maximum selection count input"
                  className="h-8 flex-1 px-2 text-sm tabular-nums"
                  id="max-count-input"
                  inputMode="numeric"
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commit();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setIsOpen(false);
                    }
                  }}
                  placeholder="e.g., 100"
                  ref={inputRef}
                  value={draft}
                />
                <Button
                  aria-label="Apply selection count"
                  className="h-8 w-8"
                  onClick={commit}
                  size="icon"
                  variant="default"
                >
                  <Check className="size-4" />
                </Button>
                <Button
                  aria-label="Cancel"
                  className="h-8 w-8"
                  onClick={() => setIsOpen(false)}
                  size="icon"
                  variant="ghost"
                >
                  <X className="size-4" />
                </Button>
              </div>
              {error && (
                <p aria-live="polite" className="text-[11px] text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <span className="text-[11px] text-muted-foreground">Quick presets</span>
              <div className="flex flex-wrap gap-1.5">
                {SELECTION_PRESETS.map((preset) => (
                  <Button
                    className={`h-7 px-2.5 text-xs ${
                      maxSelectionCount === preset.value
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : ''
                    }`}
                    key={preset.value}
                    onClick={() => applyPreset(preset.value)}
                    size="sm"
                    variant={maxSelectionCount === preset.value ? 'default' : 'outline'}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground">
              Maximum number of files that can be selected at once
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </output>
  );
});
