import type * as React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

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
  /**
   * The draft and any refusal message were discarded (Escape, or `revert()`
   * from a control that took over the value): clear what a refusal reported.
   */
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
    readonly onFocus: () => void;
    readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    readonly value: string;
  };
  /**
   * Drop the draft and its message and call `onRevert`: every control that
   * disables the field or sets its value another way must call this.
   */
  readonly revert: () => void;
}

/**
 * Every draft field rendered inside a surface that can disappear without the
 * field ever blurring — a menu or popover that unmounts on an outside click.
 * The surface commits the pending drafts from its dismissal handler and stays
 * open when one is refused, so no draft is dropped silently.
 */
export interface DraftFieldScope {
  /**
   * Commit every pending draft in the scope. `false` when any was refused; its
   * message is now shown on the field and the draft is kept.
   */
  commitAll(): boolean;
  /** @internal `useDraftField` registration; returns the unregister function. */
  register(commitPending: () => boolean): () => void;
}

export function createDraftFieldScope(): DraftFieldScope {
  const fields = new Set<() => boolean>();
  return {
    commitAll: () => {
      let landed = true;
      for (const commitPending of fields) {
        // Every field commits, even after a refusal, so each shows its own outcome.
        landed = commitPending() && landed;
      }
      return landed;
    },
    register: (commitPending) => {
      fields.add(commitPending);
      return () => {
        fields.delete(commitPending);
      };
    },
  };
}

/** Provide with `<DraftFieldScopeContext value={scope}>` around the fields. */
export const DraftFieldScopeContext = createContext<DraftFieldScope | null>(null);

/**
 * Caret keys belong to the field. A Radix submenu treats ArrowLeft (ArrowRight
 * in RTL) inside it as "close this submenu", which would take the draft along.
 */
const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight']);

/**
 * An input that edits a local DRAFT and commits it on blur or Enter; Escape
 * discards it. Keystrokes are not values: typing "128" into a 1–64 field must
 * not store 1 and 12 on the way and then leave "128" on screen beside a stored
 * 12. A refused draft stays visible with its message and stores nothing.
 * Spread `inputProps` onto the input; render `error` where the field wants it.
 * To discard drafts from outside (a "reset to defaults"), remount the field.
 * Inside a `DraftFieldScopeContext`, the scope can commit the pending draft.
 */
export function useDraftField({ commit, onRevert, value }: DraftFieldOptions): DraftField {
  const [draft, setDraftState] = useState<DraftInput | null>(null);
  const [error, setError] = useState<string | undefined>();
  // The pending draft as of the last EVENT, not the last render: a scope may
  // commit from a native event that arrives before this field re-renders.
  const pending = useRef<DraftInput | null>(null);
  // The latest render's `commit`, for a scope calling in from outside React.
  const latestCommit = useRef(commit);
  const latestOnRevert = useRef(onRevert);
  useLayoutEffect(() => {
    latestCommit.current = commit;
    latestOnRevert.current = onRevert;
  });
  // The draft whose commit was just refused. Committing it again unchanged
  // only repeats the refusal and its side effects (a refused Enter, then the
  // blur); focusing the field again clears it, since its rules may have moved.
  const refused = useRef<DraftInput | null>(null);
  const scope = useContext(DraftFieldScopeContext);

  const setDraft = useCallback((next: DraftInput | null): void => {
    pending.current = next;
    setDraftState(next);
  }, []);
  /** `true` when nothing is pending or the draft landed; `false` when refused. */
  const commitPending = useCallback((): boolean => {
    const current = pending.current;
    if (current === null) {
      return true;
    }
    if (current === refused.current) {
      return false;
    }
    const refusal = latestCommit.current(current);
    setError(refusal);
    if (refusal !== undefined) {
      refused.current = current;
      return false;
    }
    setDraft(null);
    return true;
  }, [setDraft]);
  const revert = (): void => {
    setDraft(null);
    setError(undefined);
    latestOnRevert.current?.();
  };

  useEffect(() => scope?.register(commitPending), [scope, commitPending]);

  return {
    error,
    inputProps: {
      onBlur: () => {
        commitPending();
      },
      onChange: (event) =>
        setDraft({ badInput: event.target.validity.badInput, text: event.target.value }),
      onFocus: () => {
        refused.current = null;
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          commitPending();
          return;
        }
        if (event.key === 'Escape' && (draft !== null || error !== undefined)) {
          revert();
          return;
        }
        if (CARET_KEYS.has(event.key)) {
          event.stopPropagation();
        }
      },
      value: draft?.text ?? value,
    },
    revert,
  };
}
