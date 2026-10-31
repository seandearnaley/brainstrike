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
import type { RewindConversationEffect, RewindFilesScopeModel } from '../rewind-port';

/** Amendment 1: files mode is pre-selected, and pre-selected is not hidden. */
export const DEFAULT_REWIND_MODE: AssistantRewindMode = 'conversation-and-files';

interface ScopeOption {
  /** What each option does to the conversation, by the owner's effect. */
  readonly description: Readonly<Record<RewindConversationEffect['kind'], string>>;
  readonly label: string;
  readonly mode: AssistantRewindMode;
  readonly testId: string;
}

const SCOPE_OPTIONS: readonly ScopeOption[] = [
  {
    description: {
      branched:
        'Restores the files those turns changed, and returns the conversation to before this message.',
    },
    label: 'Restore conversation and code',
    mode: 'conversation-and-files',
    testId: 'rewind-mode-conversation-and-files',
  },
  {
    description: {
      branched: 'Returns the conversation to before this message only. Nothing on disk is touched.',
    },
    label: 'Restore conversation only',
    mode: 'conversation-only',
    testId: 'rewind-mode-conversation-only',
  },
];

/**
 * `filesScope` (BST-1164 W7 T3): when the preview reports the files scope
 * unavailable — a pre-snapshot turn, or a turn whose snapshot capture
 * failed/is incomplete — the `conversation-and-files` option stays VISIBLE
 * but disabled, with the engine's own honest reason rendered under it. The
 * choice is never silently removed; the user is told exactly why only the
 * conversation can be restored.
 */
export function RewindScopeChoice({
  conversation,
  disabled,
  filesScope,
  mode,
  onModeChange,
}: {
  readonly conversation: RewindConversationEffect['kind'];
  readonly disabled: boolean;
  readonly filesScope: RewindFilesScopeModel;
  readonly mode: AssistantRewindMode;
  readonly onModeChange: (next: AssistantRewindMode) => void;
}): ReactElement {
  const filesScopeRefused = filesScope.available === false;
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2" data-testid="rewind-scope-choice">
      <legend className="pb-2 text-sm font-medium">What should be restored?</legend>
      {SCOPE_OPTIONS.map((option) => {
        const optionRefused = filesScopeRefused && option.mode === 'conversation-and-files';
        return (
          // Each option is a card whose whole surface is the radio's label; the
          // native radio inside keeps arrow-key and screen-reader behaviour.
          <label
            className={`border-border has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-ring/50 flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-xs transition-colors has-[:focus-visible]:ring-2 ${optionRefused ? 'cursor-not-allowed opacity-80' : 'hover:bg-accent/40 cursor-pointer'}`}
            htmlFor={option.testId}
            key={option.mode}
          >
            <input
              checked={mode === option.mode}
              className="accent-primary mt-0.5 size-3.5 shrink-0"
              data-testid={option.testId}
              disabled={disabled || optionRefused}
              id={option.testId}
              name="rewind-scope"
              onChange={() => onModeChange(option.mode)}
              type="radio"
              value={option.mode}
            />
            <span className="leading-snug">
              <span className="text-foreground text-sm font-medium">{option.label}</span>
              <span className="text-muted-foreground mt-0.5 block">
                {option.description[conversation]}
              </span>
              {optionRefused && filesScope.available === false ? (
                <span className="text-destructive block" data-testid="rewind-files-scope-refusal">
                  {filesScope.message}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
