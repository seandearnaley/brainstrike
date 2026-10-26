import { type DraftInput, Input, Label, useDraftField } from '@brainstrike/ui';

interface MemoryNumberFieldProps {
  readonly id: string;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  /** Called only with a whole number inside [min, max]. */
  readonly onValidChange: (value: number) => void;
  readonly step?: number;
  readonly value: number;
}

function rangeMessage(min: number, max: number): string {
  return max === Number.MAX_SAFE_INTEGER
    ? `Enter a whole number of at least ${min.toLocaleString('en-US')}.`
    : `Enter a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`;
}

function wholeNumberIn(draft: DraftInput, min: number, max: number): number | undefined {
  if (draft.badInput || draft.text.trim().length === 0) {
    return;
  }
  const value = Number(draft.text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * A memory setting's number input: a draft committed on blur or Enter
 * (`useDraftField`, as Subagent limits do). A whole number in range is saved;
 * anything else is refused under the field and saves nothing, never clamped
 * into range.
 */
export function MemoryNumberField({
  id,
  label,
  max,
  min,
  onValidChange,
  step,
  value,
}: MemoryNumberFieldProps) {
  const field = useDraftField({
    commit: (draft) => {
      const next = wholeNumberIn(draft, min, max);
      if (next === undefined) {
        return rangeMessage(min, max);
      }
      onValidChange(next);
      return;
    },
    value: String(value),
  });
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        aria-describedby={field.error ? `${id}-error` : undefined}
        aria-invalid={field.error ? true : undefined}
        id={id}
        max={max === Number.MAX_SAFE_INTEGER ? undefined : max}
        min={min}
        step={step}
        type="number"
        {...field.inputProps}
      />
      {field.error ? (
        <p className="text-destructive text-xs" id={`${id}-error`} role="alert">
          {field.error}
        </p>
      ) : null}
    </div>
  );
}
