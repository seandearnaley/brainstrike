import { useAui } from '@assistant-ui/react';
import { createLogger } from '@brainstrike/logging';
import { isMacPlatform } from '@brainstrike/ui';
import { use } from 'react';
import { FollowUpQueueOwnershipContext } from './follow-up-queue-ownership';
import { followUpQueueKey, useFollowUpQueueStore } from './follow-up-queue-store';

const logger = createLogger('FollowUpQueue');

/**
 * The steer chord, matching assistant-ui's own composer binding
 * (Shift + Ctrl/⌘ + Enter steers; Enter queues while a run is active).
 */
export const steerShortcutLabel = (): string => (isMacPlatform() ? '⇧⌘↵' : 'Ctrl+Shift+Enter');

/**
 * What the composer can do with a draft while a run is active: queue it for
 * after the run, and steer (send it now, ending the run at its next step) when
 * the app shell supplied a steering transport (BST-588). Both read the LIVE
 * composer draft, never a rendered copy, so a double click or a held key sends
 * the draft once: the first action clears it and the second finds nothing.
 * A failed steer request never loses the message; it stays queued and
 * dispatches when the run ends.
 */
export interface ComposerRunActions {
  readonly queue: () => void;
  readonly steer: (() => void) | undefined;
}

export function useComposerRunActions({
  onSteerActiveRun,
  threadKey,
}: {
  readonly onSteerActiveRun?: (() => Promise<boolean>) | undefined;
  readonly threadKey?: string | undefined;
}): ComposerRunActions | undefined {
  const ownsQueue = use(FollowUpQueueOwnershipContext);
  const aui = useAui();
  if (!ownsQueue) {
    return;
  }
  const queueKey = followUpQueueKey(threadKey);
  const takeDraft = (): string | undefined => {
    const text = aui.composer().getState().text;
    if (!text.trim()) {
      return;
    }
    aui.composer().setText('');
    return text;
  };
  return {
    queue: () => {
      const text = takeDraft();
      if (text !== undefined) {
        useFollowUpQueueStore.getState().enqueue(queueKey, text);
      }
    },
    steer: onSteerActiveRun
      ? () => {
          const text = takeDraft();
          if (text !== undefined) {
            useFollowUpQueueStore.getState().enqueueFront(queueKey, text);
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
        // queued message dispatches via the normal run-end bridge.
        logger.info('Steer control found no active run; message stays queued');
      }
    })
    .catch((error: unknown) => {
      logger.warn('Steer control request failed; message stays queued', { error });
    });
}
