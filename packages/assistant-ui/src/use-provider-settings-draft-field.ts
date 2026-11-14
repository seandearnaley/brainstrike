import { type DraftField, type DraftInput, useDraftField } from '@brainstrike/ui';

interface IntegerRange {
  /** Absent, the setting has no upper bound. */
  readonly max?: number;
  readonly min: number;
  /** What the number counts, for the refusal message ("steps"). */
  readonly noun: string;
}

const numberFormatter = new Intl.NumberFormat();

/** Empty is unset; invalid committed drafts are refused rather than clamped. */
function readIntegerDraft(
  { badInput, text }: DraftInput,
  range: IntegerRange
): { readonly value: number | undefined } | { readonly refusal: string } {
  if (!badInput && text.trim().length === 0) {
    return { value: undefined };
  }
  const value = badInput ? Number.NaN : Number(text);
  const { max, min, noun } = range;
  if (!Number.isSafeInteger(value) || value < min || (max !== undefined && value > max)) {
    return {
      refusal:
        max === undefined
          ? `Enter a whole number of ${noun}, at least ${numberFormatter.format(min)}.`
          : `Enter a whole number of ${noun} from ${numberFormatter.format(min)} to ${numberFormatter.format(max)}.`,
    };
  }
  return { value };
}

/** An optional integer setting edited as a draft and committed on blur/Enter. */
export function useIntegerSettingField(
  shown: string,
  range: IntegerRange,
  store: (value: number | undefined) => void
): DraftField {
  return useDraftField({
    commit: (draft) => {
      const parsed = readIntegerDraft(draft, range);
      if ('refusal' in parsed) {
        return parsed.refusal;
      }
      store(parsed.value);
      return;
    },
    value: shown,
  });
}
