import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import { useCallback } from 'react';

interface UseTerminalRunHandlersInput {
  readonly onRunFailed: (event: AssistantRunEvent) => void;
  readonly onRunFinished: (event: AssistantRunEvent) => void;
  readonly publishTerminalRunIdentity: (event: AssistantRunEvent) => void;
  readonly refreshChangeset: () => Promise<void>;
}

interface TerminalRunHandlers {
  readonly handleRunFailed: (event: AssistantRunEvent) => void;
  readonly handleRunFinished: (event: AssistantRunEvent) => void;
}

/**
 * Refresh the changeset when a run reaches a terminal state.
 * `publishTerminalRunIdentity` advances the standing "Last Turn" identity
 * (BST-1115) — policy in `changes/use-wrapper-rewind-wiring.ts`.
 *
 * Extracted whole from `assistant-ui-panel-wrapper.tsx` to keep that
 * composition module under its shrink-only source-file budget (BST-1844).
 */
export function useTerminalRunHandlers({
  onRunFailed,
  onRunFinished,
  publishTerminalRunIdentity,
  refreshChangeset,
}: UseTerminalRunHandlersInput): TerminalRunHandlers {
  const handleRunFinished = useCallback(
    (event: AssistantRunEvent) => {
      onRunFinished(event);
      void refreshChangeset();
      publishTerminalRunIdentity(event);
    },
    [onRunFinished, publishTerminalRunIdentity, refreshChangeset]
  );
  const handleRunFailed = useCallback(
    (event: AssistantRunEvent) => {
      onRunFailed(event);
      void refreshChangeset();
      publishTerminalRunIdentity(event);
    },
    [onRunFailed, publishTerminalRunIdentity, refreshChangeset]
  );
  return { handleRunFailed, handleRunFinished };
}
