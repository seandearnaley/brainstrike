import { useAui, useAuiState } from '@assistant-ui/react';
import { createLogger } from '@brainstrike/logging';
import { isMacPlatform } from '@brainstrike/ui';

const logger = createLogger('FollowUpQueue');

/**
 * The steer chord, matching assistant-ui's own composer binding
 * (Shift + Ctrl/⌘ + Enter steers; Enter queues while a run is active).
 */
export const steerShortcutLabel = (): string => (isMacPlatform() ? '⇧⌘↵' : 'Ctrl+Shift+Enter');

/**
 * What the composer can do with a draft while a run is active, through
 * assistant-ui's own send: queue it for after the run, and steer it (first in
 * line, and the run is asked to end at its next step) when the app shell
 * supplied a steering transport (BST-588). The vendor send takes the draft
 * and its images and clears the composer, so a double click or a held key
 * sends once. A failed steer request never loses the message; it stays first
 * in line and sends when the run ends.
 */
export interface ComposerRunActions {
  readonly queue: () => void;
  readonly steer: (() => void) | undefined;
}

export function useComposerRunActions({
  onSteerActiveRun,
}: {
  readonly onSteerActiveRun?: (() => Promise<boolean>) | undefined;
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
    steer: onSteerActiveRun
      ? () => {
          if (sendable()) {
            aui.composer().send({ steer: true });
            requestSteer(onSteerActiveRun);
          }
        }
      : undefined,
  };
}

export function requestSteer(onSteerRequest: () => Promise<boolean>): void {
  onSteerRequest()
    .then((accepted) => {
      if (!accepted) {
        // The run already finished (404 from the control endpoint) — the
        // queue sends the message at that run end.
        logger.info('Steer control found no active run; message stays queued');
      }
    })
    .catch((error: unknown) => {
      logger.warn('Steer control request failed; message stays queued', { error });
    });
}
