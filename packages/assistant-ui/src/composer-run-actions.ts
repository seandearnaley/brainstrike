import { useAui, useAuiState } from '@assistant-ui/react';
import { isMacPlatform } from '@brainstrike/ui';

/**
 * The steer chord, matching assistant-ui's own composer binding
 * (Shift + Ctrl/⌘ + Enter steers; Enter queues while a run is active).
 */
export const steerShortcutLabel = (): string => (isMacPlatform() ? '⇧⌘↵' : 'Ctrl+Shift+Enter');

/**
 * What the composer can do with a draft while a run is active, through
 * assistant-ui's own send: queue it for after the run, and steer it into the
 * running run, which reads it at its next step, when the thread can steer
 * (`thread-message-queue.ts`). The vendor send takes the draft and its images
 * and clears the composer, so a double click or a held key sends once.
 */
export interface ComposerRunActions {
  readonly queue: () => void;
  readonly steer: (() => void) | undefined;
}

export function useComposerRunActions({
  canSteer,
}: {
  readonly canSteer?: boolean | undefined;
}): ComposerRunActions | undefined {
  const aui = useAui();
  const hasQueue = useAuiState((state) => state.thread.capabilities.queue);
  if (!hasQueue) {
    return;
  }
  const sendable = (): boolean => {
    const composer = aui.composer().getState();
    return composer.canSend && !composer.isEmpty;
  };
  return {
    queue: () => {
      if (sendable()) {
        aui.composer().send({ steer: false });
      }
    },
    steer: canSteer
      ? () => {
          if (sendable()) {
            aui.composer().send({ steer: true });
          }
        }
      : undefined,
  };
}
