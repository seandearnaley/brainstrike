// Import the union rather than duplicating it: a fifth origin added to
// WorkspaceOpenOrigin (packages/app-shell/src/workspace-connect/workspace-connect-bridge.ts)
// must not silently miss this queue's contract.
import type { WorkspaceOpenOrigin } from '@brainstrike/app-shell/workspace-connect/workspace-connect-bridge';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('WorkspaceOpenQueue');

/**
 * Holds folder-open REQUESTS until a visible renderer can receive them
 * (BST-1393, spec §7 [D10]).
 *
 * Three producers fire before a renderer exists: macOS `open-file` (which
 * arrives before `whenReady`), first-launch argv, and a `second-instance`
 * whose window is still restoring. Delivering into a missing or unloaded
 * renderer would drop the user's request silently, which is exactly the
 * failure this queue exists to prevent.
 *
 * It is a DELIVERY buffer, never an authorization: each request is a path
 * string that the renderer still has to route through `fs:addRootByPath`.
 */
export interface WorkspaceOpenRequest {
  readonly origin: WorkspaceOpenOrigin;
  readonly path: string;
}

/**
 * A launch cannot legitimately name more folders than this. The bound is
 * against a runaway producer (a `second-instance` storm), not against the
 * user; the OLDEST is dropped with a warn, because the newest request is the
 * one the user is looking at.
 */
export const MAX_PENDING_OPEN_REQUESTS = 16;

export interface WorkspaceOpenDeliveryTarget {
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: unknown) => void;
}

export function createWorkspaceOpenQueue(channel: string) {
  let target: WorkspaceOpenDeliveryTarget | null = null;
  const pending: WorkspaceOpenRequest[] = [];

  const flush = (): void => {
    if (!target || target.isDestroyed()) {
      return;
    }
    // Splice-then-send: a throwing `send` must not replay the whole queue on
    // the next flush, and the ordering the user typed is preserved.
    const draining = pending.splice(0, pending.length);
    for (const request of draining) {
      target.send(channel, request);
    }
  };

  return {
    /** The renderer has loaded and is listening. Idempotent. */
    attach(next: WorkspaceOpenDeliveryTarget): void {
      target = next;
      flush();
    },
    enqueue(request: WorkspaceOpenRequest): void {
      if (pending.length >= MAX_PENDING_OPEN_REQUESTS) {
        const dropped = pending.shift();
        logger.warn('Dropped the oldest pending folder-open request', {
          origin: dropped?.origin,
        });
      }
      pending.push(request);
      flush();
    },
    /** Test seam only. */
    reset(): void {
      pending.length = 0;
      target = null;
    },
  };
}

export type WorkspaceOpenQueue = ReturnType<typeof createWorkspaceOpenQueue>;
