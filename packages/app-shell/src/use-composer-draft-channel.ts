import { useLayoutEffect } from 'react';
import {
  type AssistantComposerCommand,
  useAssistantComposerCommandStore,
} from './assistant-composer-command-store';

/** One thread's composer draft channel, as the panel consumes it. */
export interface ComposerDraftChannel {
  /** The composer command waiting for this thread, if any. */
  readonly command: AssistantComposerCommand | undefined;
  /** Acknowledges a command only once its text is in the draft. */
  readonly onApplied: (commandId: string) => void;
  /** Records the live draft so the carry can read it. */
  readonly onTextChange: (text: string) => void;
}

/**
 * The per-thread composer draft channel: the queued composer command,
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
  const restoreDraft = useAssistantComposerCommandStore((state) => state.restoreDraft);
  // A composer mounts empty, so one mounted again (the new-thread screen after
  // another tab was open) takes back the text it had not sent. A layout effect,
  // so the command is queued before the empty composer records its text.
  // biome-ignore lint/plugin: a mount-time restore into the external draft store, not an event handler
  useLayoutEffect(() => {
    if (threadId) {
      restoreDraft(threadId);
    }
  }, [restoreDraft, threadId]);
  const onApplied = (commandId: string) => {
    if (!command || command.id !== commandId) {
      throw new Error(`Cannot acknowledge unknown composer command: ${commandId}`);
    }
    acknowledgeCommand(command.threadId, commandId);
  };
  const onTextChange = (text: string) => {
    if (!threadId) {
      throw new Error('Cannot record composer text without an active assistant thread.');
    }
    recordDraft(threadId, text);
  };
  return { command, onApplied, onTextChange };
}
