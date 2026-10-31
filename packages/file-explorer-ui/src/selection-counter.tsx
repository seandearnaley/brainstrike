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
import { useMemo, useRef, useState } from 'react';
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
  if (!/^\d+$/u.test(trimmed)) {
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

export function SelectionCounter({
  selectedCount,
  maxSelectionCount,
  onMaxSelectionCountChange,
  compact = false,
}: SelectionCounterProps) {
  const isEditable = typeof onMaxSelectionCountChange === 'function';
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isAtLimit = selectedCount >= maxSelectionCount;
  const isNearLimit = selectedCount >= maxSelectionCount * 0.9;

  const handleOpenChange = (open: boolean) => {
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
  };

  const commit = () => {
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
  };

  const applyPreset = (value: number) => {
    if (typeof onMaxSelectionCountChange === 'function') {
      onMaxSelectionCountChange(value);
      setIsOpen(false);
    }
  };

  const tooltipLabel = useMemo(() => {
    if (!isEditable) {
      return 'Selection count (read-only)';
    }
    return 'Click to edit maximum selection count';
  }, [isEditable]);
  const accessibleLabel = `${selectedCount} of ${maxSelectionCount} files selected. ${tooltipLabel}`;
  // The fraction must stay single-scale: compact mode abbreviates the count
  // from 1000 up, and ONCE IT DOES the max abbreviates with it — "2K/2000"
  // mixed two scales in one fraction. Below 1000 both sides stay exact
  // ("629/1000"); count can never exceed max, so a mixed pair cannot occur.
  // Exact values always remain in the accessible label.
  const isCountCompacted = compact && selectedCount >= 1000;
  const visibleSelectedCount = compact
    ? formatCompactSelectionCount(selectedCount)
    : String(selectedCount);
  const visibleMaxCount = isCountCompacted
    ? formatCompactSelectionCount(maxSelectionCount)
    : String(maxSelectionCount);

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
      className={`flex h-8 items-center gap-1 rounded-md border @[300px]:h-9 @[300px]:gap-1.5 @[300px]:px-2.5 ${
        compact ? 'px-1 text-xs @[72px]:px-1.5 @[72px]:text-sm @[96px]:px-2' : 'px-2 text-sm'
      } focus-visible:ring-ring py-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none ${statusStyles} ${
        isEditable ? 'cursor-pointer' : 'cursor-default'
      }`}
      disabled={!isEditable}
      onClick={() => isEditable && handleOpenChange(true)}
      type="button"
    >
      {!compact && <Files className="text-muted-foreground size-3.5 @[300px]:mr-2" />}
      <span className="font-medium tabular-nums">
        <span data-testid="selection-count">{visibleSelectedCount}</span>
        <span
          className={compact ? 'hidden @[96px]:inline' : undefined}
          data-testid="selection-count-suffix"
        >
          <span className="mx-0.5">/</span>
          <span data-testid="selection-max">{visibleMaxCount}</span>
        </span>
      </span>
      {isEditable && (
        <Pencil className="text-muted-foreground hidden size-3 @[300px]:ml-2 @[300px]:inline" />
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
              <label className="text-foreground text-xs font-medium" htmlFor="max-count-input">
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
                <p aria-live="polite" className="text-destructive text-[11px]" role="alert">
                  {error}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <span className="text-muted-foreground text-[11px]">Quick presets</span>
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

            <p className="text-muted-foreground text-[10px]">
              Maximum number of files that can be selected at once
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </output>
  );
}
