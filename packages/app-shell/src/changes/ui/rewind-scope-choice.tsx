/**
 * The scope choice of the Conversation Rewind confirm modal (Amendment 1 A1.1).
 *
 * THE CHOICE IS ALWAYS VISIBLE AND ALWAYS EXPLICIT. `conversation-and-files` is
 * the pre-selected default because restoring the code is the headline feature —
 * but it is a SELECTED radio the user can see and change, never a hidden
 * default that silently reverts files. The wire contract enforces the same
 * thing (`applyRewind` has no default mode), so a UI that forgot to pass one
 * fails loudly instead of picking for the user.
 */
import type { AssistantRewindMode } from '@brainstrike/assistant-contract';
import type { ReactElement } from 'react';

/** Amendment 1: files mode is pre-selected, and pre-selected is not hidden. */
export const DEFAULT_REWIND_MODE: AssistantRewindMode = 'conversation-and-files';

interface ScopeOption {
  readonly description: string;
  readonly label: string;
  readonly mode: AssistantRewindMode;
  readonly testId: string;
}

const SCOPE_OPTIONS: readonly ScopeOption[] = [
  {
    description: 'Restores the files those turns changed, and hides the messages.',
    label: 'Restore conversation and code',
    mode: 'conversation-and-files',
    testId: 'rewind-mode-conversation-and-files',
  },
  {
    description: 'Hides the messages only. Nothing on disk is touched.',
    label: 'Restore conversation only',
    mode: 'conversation-only',
    testId: 'rewind-mode-conversation-only',
  },
];

export function RewindScopeChoice({
  disabled,
  mode,
  onModeChange,
}: {
  readonly disabled: boolean;
  readonly mode: AssistantRewindMode;
  readonly onModeChange: (next: AssistantRewindMode) => void;
}): ReactElement {
  return (
    <fieldset className="flex flex-col gap-1.5" data-testid="rewind-scope-choice">
      <legend className="pb-1 font-medium text-xs">What should be restored?</legend>
      {SCOPE_OPTIONS.map((option) => (
        <label
          className="flex cursor-pointer items-start gap-2 text-xs"
          htmlFor={option.testId}
          key={option.mode}
        >
          <input
            checked={mode === option.mode}
            className="mt-0.5 accent-primary"
            data-testid={option.testId}
            disabled={disabled}
            id={option.testId}
            name="rewind-scope"
            onChange={() => onModeChange(option.mode)}
            type="radio"
            value={option.mode}
          />
          <span className="leading-tight">
            <span className="font-medium text-foreground">{option.label}</span>
            <span className="block text-muted-foreground">{option.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
