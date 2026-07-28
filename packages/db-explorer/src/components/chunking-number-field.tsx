import type { ChunkingSettingFieldResult } from '@brainstrike/indexing-contract';
import { Input, Label } from '@brainstrike/ui';
import { useId, useState } from 'react';

interface ChunkingNumberFieldProps {
  readonly id: string;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  /** Called ONLY with a value that passed validation. */
  readonly onCommit: (value: number) => void;
  readonly step?: number;
  /** Canonical validator from @brainstrike/indexing-contract. */
  readonly validate: (value: number) => ChunkingSettingFieldResult;
  readonly value: number;
}

/**
 * BST-423 — a numeric settings input that REJECTS impossible values instead of
 * clamping them, and says why.
 *
 * Two things make this more than an `<input type="number">`:
 *
 * 1. **Draft state.** Typing "512" passes through "5" and "51", both below the
 *    minimum. A purely controlled input bound to the committed store value
 *    would snap back on every keystroke and be impossible to type into. The
 *    draft holds the raw string; only a value that validates is committed.
 *
 * 2. **Validation in JS, not HTML.** The `min`/`max` attributes are kept for
 *    native spinner affordances and assistive tech, but a browser does not
 *    enforce them against typing or paste — which is exactly how out-of-range
 *    values reached the store before. They are a hint here, never the guard.
 *
 * The validator is injected rather than reimplemented so this field and the
 * persisted store share one definition of the rules.
 */
export function ChunkingNumberField({
  id,
  label,
  max,
  min,
  onCommit,
  step,
  validate,
  value,
}: ChunkingNumberFieldProps) {
  // `undefined` means "not editing" — show the committed value.
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const errorId = useId();

  // Review follow-up on #2086: the draft used to be cleared only on blur, so it
  // could go stale against `value`. When the committed value changes from
  // OUTSIDE this field — a preset chip, the token-cap Select, the cross-field
  // partner — the input kept rendering the old draft and its now-wrong error,
  // which is exactly what the blur handler promises can never happen. Deriving
  // from the committed value during render (rather than an effect) drops both
  // the moment the store moves, with no extra render pass.
  const [lastCommitted, setLastCommitted] = useState(value);
  if (lastCommitted !== value) {
    setLastCommitted(value);
    setDraft(undefined);
    setError(undefined);
  }

  const handleChange = (raw: string) => {
    setDraft(raw);
    // An emptied field is not a zero. `Number('')` is 0, which used to be
    // absorbed by the store's clamp into a plausible-looking default.
    const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
    const result = validate(parsed);
    if (result.ok) {
      setError(undefined);
      onCommit(result.value);
      return;
    }
    setError(result.issue.message);
  };

  return (
    <div>
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      <Input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        className="mt-1 h-8 text-sm"
        id={id}
        max={String(max)}
        min={String(min)}
        onBlur={() => {
          // Leaving the field discards an uncommitted draft so the input never
          // displays a value the store does not hold.
          setDraft(undefined);
          setError(undefined);
        }}
        onChange={(event) => handleChange(event.target.value)}
        {...(step === undefined ? {} : { step: String(step) })}
        type="number"
        value={draft ?? String(value)}
      />
      {error ? (
        <p className="mt-1 text-destructive text-xs" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
