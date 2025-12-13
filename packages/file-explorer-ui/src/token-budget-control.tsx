import { DEFAULT_TOKEN_BUDGET } from '@brainstrike/types';
import { Badge, Button, Input } from '@brainstrike/ui';
import { Check, Pencil, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

function formatBudget(budget: number): string {
  return budget.toLocaleString();
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

export type TokenBudgetControlProps = {
  budget?: number;
  onBudgetChange?: ((budget: number) => void) | undefined;
};

export const TokenBudgetControl = memo<TokenBudgetControlProps>(function TokenBudgetControl({
  budget = DEFAULT_TOKEN_BUDGET,
  onBudgetChange,
}) {
  const isEditable = typeof onBudgetChange === 'function';
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [isEditing]);

  const startEditing = useCallback(() => {
    if (!isEditable) {
      return;
    }

    setIsEditing(true);
    setDraft(String(budget));
    setError(null);
  }, [budget, isEditable]);

  const commit = useCallback(() => {
    if (typeof onBudgetChange !== 'function') {
      setIsEditing(false);
      return;
    }

    const parsed = parseBudgetInput(draft);
    if (parsed === null) {
      setError('Enter a valid token budget');
      return;
    }

    onBudgetChange(parsed);
    setIsEditing(false);
  }, [draft, onBudgetChange]);

  const cancel = useCallback(() => {
    setIsEditing(false);
    setDraft(formatBudget(budget));
    setError(null);
  }, [budget]);

  const description = useMemo(() => {
    if (!isEditable) {
      return 'Token budget (read-only)';
    }
    return 'Token budget';
  }, [isEditable]);

  if (!isEditing) {
    return (
      <Badge className="flex items-center gap-1 py-1.5" title={description} variant="outline">
        <span className="text-muted-foreground text-xs">Budget</span>
        <span className="font-medium tabular-nums">{formatBudget(budget)}</span>
        {isEditable && (
          <Button
            aria-label="Edit token budget"
            className="h-6 w-6"
            onClick={startEditing}
            size="icon"
            variant="ghost"
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
      </Badge>
    );
  }

  return (
    <Badge className="flex items-center gap-1 py-1.5" title={description} variant="outline">
      <span className="text-muted-foreground text-xs">Budget</span>
      <Input
        aria-label="Token budget input"
        className="h-7 w-28 px-2 py-1 text-xs tabular-nums"
        inputMode="numeric"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
        ref={inputRef}
        value={draft}
      />
      <Button
        aria-label="Save token budget"
        className="h-6 w-6"
        onClick={commit}
        size="icon"
        variant="ghost"
      >
        <Check className="size-3.5" />
      </Button>
      <Button
        aria-label="Cancel token budget edit"
        className="h-6 w-6"
        onClick={cancel}
        size="icon"
        variant="ghost"
      >
        <X className="size-3.5" />
      </Button>
      {error && <span className="ml-1 text-[10px] text-destructive">{error}</span>}
    </Badge>
  );
});
