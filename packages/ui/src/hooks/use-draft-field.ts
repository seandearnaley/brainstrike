import type * as React from 'react';
import { useState } from 'react';

/**
 * What the user typed. A number input reports `text: ''` for unparseable text
 * ("1.", "-", "1e"); `badInput` is the browser's own report of that, so an
 * empty-means-unset field never reads a half-typed number as empty.
 */
export interface DraftInput {
  readonly badInput: boolean;
  readonly text: string;
}

export interface DraftFieldOptions {
  /**
   * Validate and store the draft. Return the refusal message, or `undefined`
   * once the value landed. Throw only for a defect: a throw propagates.
   */
  readonly commit: (draft: DraftInput) => string | undefined;
  /** Escape discarded the draft (and any refusal message). */
  readonly onRevert?: () => void;
  /** The stored value's text, shown whenever no draft is being edited. */
  readonly value: string;
}

export interface DraftField {
  /** The last commit's refusal message; cleared by a landed commit or Escape. */
  readonly error: string | undefined;
  readonly inputProps: {
    readonly onBlur: () => void;
    readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    readonly value: string;
  };
  /** Drop the draft and its message, e.g. when the field is switched off. */
  readonly revert: () => void;
}

/**
 * An input that edits a local DRAFT and commits it on blur or Enter; Escape
 * discards it. Keystrokes are not values: typing "128" into a 1–64 field must
 * not store 1 and 12 on the way and then leave "128" on screen beside a stored
 * 12. A refused draft stays visible with its message and stores nothing.
 * Spread `inputProps` onto the input; render `error` where the field wants it.
 * To discard drafts from outside (a "reset to defaults"), remount the field.
 */
export function useDraftField({ commit, onRevert, value }: DraftFieldOptions): DraftField {
  const [draft, setDraft] = useState<DraftInput | null>(null);
  const [error, setError] = useState<string | undefined>();

  const commitDraft = (): void => {
    if (draft === null) {
      return;
    }
    const refusal = commit(draft);
    setError(refusal);
    if (refusal === undefined) {
      setDraft(null);
    }
  };
  const revert = (): void => {
    setDraft(null);
    setError(undefined);
  };

  return {
    error,
    inputProps: {
      onBlur: commitDraft,
      onChange: (event) =>
        setDraft({ badInput: event.target.validity.badInput, text: event.target.value }),
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          commitDraft();
          return;
        }
        if (event.key === 'Escape' && (draft !== null || error !== undefined)) {
          revert();
          onRevert?.();
        }
      },
      value: draft?.text ?? value,
    },
    revert,
  };
}
