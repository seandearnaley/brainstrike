import { DEFAULT_TOKEN_BUDGET, MAX_TOKEN_BUDGET } from '@brainstrike/types';
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
import { Check, Pencil, Target, X } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';

function formatBudget(budget: number): string {
  return budget.toLocaleString();
}

function formatBudgetCompact(budget: number): string {
  if (budget >= 1_000_000) {
    return `${(budget / 1_000_000).toFixed(budget % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (budget >= 1000) {
    return `${(budget / 1000).toFixed(budget % 1000 === 0 ? 0 : 1)}K`;
  }
  return budget.toString();
}

function parseBudgetInput(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const cleaned = trimmed
    .replace(/tokens?$/u, '')
    .trim()
    .replace(/[,_\s]/gu, '');

  const match = /^(\d+(?:\.\d+)?)([kmb])?$/u.exec(cleaned);
  if (!match) {
    return null;
  }

  const base = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(base)) {
    return null;
  }

  const suffix = match[2] ?? '';
  const multiplier =
    suffix === 'k' ? 1000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;

  const value = Math.round(base * multiplier);
  return value > 0 ? value : null;
}

// Quick budget preset buttons
const BUDGET_PRESETS = [
  { label: '32K', value: 32_000 },
  { label: '64K', value: 64_000 },
  { label: '100K', value: 100_000 },
  { label: '128K', value: 128_000 },
  { label: '200K', value: 200_000 },
] as const;

export interface TokenBudgetControlProps {
  budget?: number;
  compact?: boolean;
  onBudgetChange?: ((budget: number) => void) | undefined;
}

export const TokenBudgetControl = memo<TokenBudgetControlProps>(function TokenBudgetControl({
  budget = DEFAULT_TOKEN_BUDGET,
  onBudgetChange,
  compact = false,
}) {
  const isEditable = typeof onBudgetChange === 'function';
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        // Initialize draft with current budget when opening
        setDraft(String(budget));
        setError(null);
        // Focus and select input after render
        queueMicrotask(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    },
    [budget]
  );

  const commit = useCallback(() => {
    if (typeof onBudgetChange !== 'function') {
      setIsOpen(false);
      return;
    }

    const parsed = parseBudgetInput(draft);
    if (parsed === null) {
      setError('Enter a valid number (e.g., 100k, 200000)');
      return;
    }

    if (parsed > MAX_TOKEN_BUDGET) {
      setError(`Maximum budget is ${MAX_TOKEN_BUDGET.toLocaleString()} tokens`);
      return;
    }

    onBudgetChange(parsed);
    setIsOpen(false);
  }, [draft, onBudgetChange]);

  const applyPreset = useCallback(
    (value: number) => {
      if (typeof onBudgetChange === 'function') {
        onBudgetChange(value);
        setIsOpen(false);
      }
    },
    [onBudgetChange]
  );

  const tooltipLabel = useMemo(() => {
    if (!isEditable) {
      return 'Token budget (read-only)';
    }
    return 'Click to edit token budget';
  }, [isEditable]);

  const triggerButton = (
    <button
      aria-label={tooltipLabel}
      className={`group flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm transition-colors hover:border-accent-foreground/20 hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 ${
        isEditable ? 'cursor-pointer' : 'cursor-default'
      }`}
      disabled={!isEditable}
      onClick={() => isEditable && handleOpenChange(true)}
      type="button"
    >
      <Target className="size-3.5 text-muted-foreground" />
      {compact ? (
        <span className="font-medium tabular-nums">{formatBudgetCompact(budget)}</span>
      ) : (
        <>
          <span className="@[600px]:inline hidden font-medium tabular-nums">
            {formatBudget(budget)}
          </span>
          <span className="inline @[600px]:hidden font-medium tabular-nums">
            {formatBudgetCompact(budget)}
          </span>
        </>
      )}
      {isEditable && <Pencil className="size-3 text-muted-foreground" />}
    </button>
  );

  if (!isEditable) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="text-xs">
              <div className="font-medium">Token Budget</div>
              <div className="text-muted-foreground">{formatBudget(budget)} tokens (read-only)</div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={isOpen}>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
          </TooltipTrigger>
          {!isOpen && (
            <TooltipContent side="bottom">
              <div className="text-xs">Click to edit budget</div>
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      <PopoverContent align="start" className="w-64 p-3" side="bottom">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="font-medium text-foreground text-xs" htmlFor="budget-input">
              Token Budget
            </label>
            <div className="flex gap-1.5">
              <Input
                aria-label="Token budget input"
                className="h-8 flex-1 px-2 text-sm tabular-nums"
                id="budget-input"
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
                placeholder="e.g., 100k"
                ref={inputRef}
                value={draft}
              />
              <Button
                aria-label="Apply budget"
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
            {error && <p className="text-[11px] text-destructive">{error}</p>}
          </div>

          <div className="space-y-1.5">
            <span className="text-[11px] text-muted-foreground">Quick presets</span>
            <div className="flex flex-wrap gap-1.5">
              {BUDGET_PRESETS.map((preset) => (
                <Button
                  className={`h-7 px-2.5 text-xs ${
                    budget === preset.value
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : ''
                  }`}
                  key={preset.value}
                  onClick={() => applyPreset(preset.value)}
                  size="sm"
                  variant={budget === preset.value ? 'default' : 'outline'}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>

          <p className="text-[10px] text-muted-foreground">
            Supports: numbers, k (thousands), m (millions)
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
});
