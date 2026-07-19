/**
 * SelectionModeBadge - Displays selection state and exposes a unified settings popover.
 *
 * In wide layouts it can render as the legacy badge trigger.
 * In compact layouts it can render as a settings button that keeps the footer narrow.
 */

import { MAX_SELECTION_COUNT, MIN_MAX_SELECTION_COUNT } from '@brainstrike/types';
import {
  Badge,
  Button,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Check, CheckSquare, Settings2, X } from 'lucide-react';
import { memo, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { parseCountInput, SELECTION_PRESETS } from './selection-counter';

export interface SelectionModeBadgeProps {
  compactValue?: {
    accessibleLabel: string;
    label: string;
  };
  maxSelectionCount?: number;
  onMaxSelectionCountChange?: ((count: number) => void) | undefined;
  /** Whether to show the badge (handles conditional rendering internally) */
  show?: boolean;
  triggerVariant?: 'badge' | 'icon';
}

interface SelectionSettingsPanelProps {
  draft: string;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  maxSelectionCount: number | undefined;
  onDraftChange: (value: string) => void;
  onMaxSelectionCountChange?: ((count: number) => void) | undefined;
  onSubmitMaxSelectionCount: () => void;
  onToggleOpen: (open: boolean) => void;
}

const SelectionSettingsPanel = ({
  draft,
  error,
  inputRef,
  maxSelectionCount,
  onDraftChange,
  onMaxSelectionCountChange,
  onSubmitMaxSelectionCount,
  onToggleOpen,
}: SelectionSettingsPanelProps) => (
  <div className="space-y-4">
    <div className="space-y-1">
      <h4 className="font-medium text-sm">Selection Settings</h4>
      <p className="text-muted-foreground text-xs">Tune bulk selection limits.</p>
    </div>

    {typeof maxSelectionCount === 'number' && (
      <div className="space-y-3 border-t pt-3">
        <div className="space-y-1">
          <p className="font-medium text-xs">Selection Cap</p>
          <p className="text-[11px] text-muted-foreground">
            Limit how many files bulk actions can select at once.
          </p>
        </div>

        <div className="flex gap-1.5">
          <Input
            aria-label="Maximum selection count input"
            className="h-8 flex-1 px-2 text-sm tabular-nums"
            inputMode="numeric"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmitMaxSelectionCount();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onToggleOpen(false);
              }
            }}
            placeholder="e.g., 100"
            ref={inputRef}
            value={draft}
          />
          <Button
            aria-label="Apply selection count"
            className="h-8 w-8"
            onClick={onSubmitMaxSelectionCount}
            size="icon-sm"
            variant="default"
          >
            <Check className="size-4" />
          </Button>
          <Button
            aria-label="Close selection settings"
            className="h-8 w-8"
            onClick={() => onToggleOpen(false)}
            size="icon-sm"
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

        <div className="space-y-1.5">
          <span className="text-[11px] text-muted-foreground">Quick presets</span>
          <div className="grid grid-cols-4 gap-1.5">
            {SELECTION_PRESETS.map((preset) => (
              <Button
                className="h-7 px-0 text-xs"
                key={preset.value}
                onClick={() => {
                  if (typeof onMaxSelectionCountChange === 'function') {
                    onMaxSelectionCountChange(preset.value);
                    onToggleOpen(false);
                  }
                }}
                size="sm"
                variant={maxSelectionCount === preset.value ? 'default' : 'outline'}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    )}
  </div>
);

export const SelectionModeBadge = memo<SelectionModeBadgeProps>(function SelectionModeBadge({
  compactValue,
  maxSelectionCount,
  onMaxSelectionCountChange,
  show = true,
  triggerVariant = 'badge',
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<string>(String(maxSelectionCount ?? ''));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);

  const cleanupFocusFrame = useCallback(() => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current);
    }
  }, []);

  useEffect(() => cleanupFocusFrame, [cleanupFocusFrame]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = null;
      }

      setIsOpen(open);
      if (open) {
        setDraft(String(maxSelectionCount ?? ''));
        setError(null);
        focusFrameRef.current = requestAnimationFrame(() => {
          focusFrameRef.current = null;
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    },
    [maxSelectionCount]
  );

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    setError(null);
  }, []);

  const commitMaxSelectionCount = useCallback(() => {
    if (typeof onMaxSelectionCountChange !== 'function') {
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

  const tooltipText = triggerVariant === 'icon' ? 'Selection settings.' : 'Manual selection mode';

  if (!show) {
    return null;
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={isOpen}>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              {triggerVariant === 'icon' ? (
                <Button
                  aria-label={
                    compactValue
                      ? `Selection settings. ${compactValue.accessibleLabel}`
                      : 'Selection settings'
                  }
                  className={cn(compactValue && 'text-[10px] tabular-nums')}
                  data-testid="selection-settings-button"
                  size="icon-xs"
                  variant="outline"
                >
                  <Settings2 className={cn('size-3.5', compactValue && '@[72px]:block hidden')} />
                  {compactValue && (
                    <span className="@[72px]:hidden" data-testid="selection-compact-count">
                      {compactValue.label}
                    </span>
                  )}
                </Button>
              ) : (
                <Badge
                  className="flex h-7 cursor-pointer items-center gap-1 px-2 transition-colors hover:bg-accent"
                  data-testid="selection-mode-badge"
                  variant="outline"
                >
                  <CheckSquare className="mr-1 h-3 w-3" />
                  <span className="text-xs">Manual</span>
                </Badge>
              )}
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">
              {tooltipText}
              {compactValue ? ` ${compactValue.accessibleLabel}` : ''}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent align="end" className="w-80 p-3" side="bottom">
        <SelectionSettingsPanel
          draft={draft}
          error={error}
          inputRef={inputRef}
          maxSelectionCount={maxSelectionCount}
          onDraftChange={handleDraftChange}
          onMaxSelectionCountChange={onMaxSelectionCountChange}
          onSubmitMaxSelectionCount={commitMaxSelectionCount}
          onToggleOpen={setIsOpen}
        />
      </PopoverContent>
    </Popover>
  );
});
