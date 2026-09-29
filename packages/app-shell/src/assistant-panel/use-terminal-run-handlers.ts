import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import { useCallback } from 'react';

interface UseTerminalRunHandlersInput {
  readonly onRunFailed: (event: AssistantRunEvent) => void;
  readonly onRunFinished: (event: AssistantRunEvent) => void;
  readonly publishTerminalRunIdentity: (event: AssistantRunEvent) => void;
  readonly refetchCheckpoints: () => Promise<void>;
  readonly refreshChangeset: () => Promise<void>;
}

interface TerminalRunHandlers {
  readonly handleRunFailed: (event: AssistantRunEvent) => void;
  readonly handleRunFinished: (event: AssistantRunEvent) => void;
}

/**
 * Re-read the checkpoint journal when a run reaches a terminal state — the
 * journal rows are written in main during tool execution, after the last
 * thread-open read, so the turn-level "Revert all edits" footer would
 * otherwise stay empty for the turn that JUST ran until a thread switch.
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
  refetchCheckpoints,
  refreshChangeset,
}: UseTerminalRunHandlersInput): TerminalRunHandlers {
  const handleRunFinished = useCallback(
    (event: AssistantRunEvent) => {
      onRunFinished(event);
      void refetchCheckpoints();
      void refreshChangeset();
      publishTerminalRunIdentity(event);
    },
    [onRunFinished, publishTerminalRunIdentity, refetchCheckpoints, refreshChangeset]
  );
  const handleRunFailed = useCallback(
    (event: AssistantRunEvent) => {
      onRunFailed(event);
      void refetchCheckpoints();
      void refreshChangeset();
      publishTerminalRunIdentity(event);
    },
    [onRunFailed, publishTerminalRunIdentity, refetchCheckpoints, refreshChangeset]
  );
  return { handleRunFailed, handleRunFinished };
}
