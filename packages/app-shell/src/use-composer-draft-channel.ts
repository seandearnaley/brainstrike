import { useCallback } from 'react';
import {
  type AssistantComposerCommand,
  useAssistantComposerCommandStore,
} from './assistant-composer-command-store';

/** One thread's composer draft channel, as the panel consumes it. */
export interface ComposerDraftChannel {
  /** The prompt-library command waiting for this thread, if any. */
  readonly command: AssistantComposerCommand | undefined;
  /** Acknowledges a command only once its text is in the draft. */
  readonly onApplied: (commandId: string) => void;
  /** Records the live draft so prompt recall and the carry can read it. */
  readonly onTextChange: (text: string) => void;
}

/**
 * The per-thread composer draft channel: the queued prompt-library command,
 * its acknowledgement and the live-draft recorder. One unit because they share the same
 * thread-scoped store and the same lifetime; extracted from
 * `assistant-ui-panel-wrapper.tsx`, which owns none of this state itself.
 */
export function useComposerDraftChannel(threadId: string | undefined): ComposerDraftChannel {
  const command = useAssistantComposerCommandStore((state) =>
    threadId ? state.commandsByThreadId[threadId]?.[0] : undefined
  );
  const acknowledgeCommand = useAssistantComposerCommandStore((state) => state.acknowledge);
  const recordDraft = useAssistantComposerCommandStore((state) => state.recordDraft);
  const onApplied = useCallback(
    (commandId: string) => {
      if (!command || command.id !== commandId) {
        throw new Error(`Cannot acknowledge unknown composer command: ${commandId}`);
      }
      acknowledgeCommand(command.threadId, commandId);
    },
    [acknowledgeCommand, command]
  );
  const onTextChange = useCallback(
    (text: string) => {
      if (!threadId) {
        throw new Error('Cannot record composer text without an active assistant thread.');
      }
      recordDraft(threadId, text);
    },
    [recordDraft, threadId]
  );
  return { command, onApplied, onTextChange };
}
