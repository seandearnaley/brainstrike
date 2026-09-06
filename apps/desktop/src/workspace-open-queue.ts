import fs from 'node:fs';
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
    for (const [index, request] of draining.entries()) {
      try {
        target.send(channel, request);
      } catch (error) {
        // The target died mid-drain (destroyed between the isDestroyed()
        // check above and this send). NO SILENT FALLBACK: surface the loss
        // rather than dropping the remainder of the batch on the floor, and
        // re-buffer the unsent remainder for the next attach instead of
        // consuming it against a dead renderer. The exception must never
        // escape into the Electron event handler that called enqueue()/
        // attach() (`open-file`, `did-finish-load`, ...).
        logger.warn('Folder-open delivery failed mid-drain; re-buffering the remainder', {
          error: error instanceof Error ? error.message : String(error),
          origin: request.origin,
          remaining: draining.length - index,
        });
        pending.unshift(...draining.slice(index));
        target = null;
        return;
      }
    }
  };

  return {
    /** The renderer has loaded and is listening. Idempotent. */
    attach(next: WorkspaceOpenDeliveryTarget): void {
      target = next;
      flush();
    },
    /**
     * The current target can no longer receive deliveries (a reload or
     * navigation has torn down the document that had `WorkspaceConnectHost`
     * mounted, before the new one re-subscribes). Call from `did-start-loading`
     * so a request arriving mid-reload buffers instead of being `send` into a
     * page with no listener — the following `did-finish-load` re-attach
     * delivers it. Idempotent; safe to call with no target attached.
     */
    detach(): void {
      target = null;
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

/**
 * Enqueue every candidate from one producer (argv, `second-instance`) under
 * a single `origin`. Factored out of `main.ts` so the `app.whenReady()` and
 * `second-instance` closures — both already near Biome's per-function
 * cognitive-complexity ceiling — gain one call each instead of a second
 * inline loop (BST-1393 plan, Global Constraints: extract rather than
 * shrink the feature).
 */
export function enqueueFolderCandidates(
  queue: WorkspaceOpenQueue,
  candidates: readonly string[],
  origin: WorkspaceOpenOrigin
): void {
  for (const candidate of candidates) {
    queue.enqueue({ origin, path: candidate });
  }
}

/**
 * Filters argv/open-file/second-instance candidates down to real, readable
 * DIRECTORIES before they ever reach the queue.
 *
 * macOS `open-file` routinely delivers FILE paths as a matter of course
 * ("Open With…" on a document), so a non-directory candidate is the expected
 * case here, not an edge one. Forwarding one through to `fs:addRootByPath`
 * would describe a wiring mismatch as a permission problem (the same
 * match-the-failure-to-the-remedy reasoning as ruling S2). A stat failure
 * (ENOENT, EACCES, a dangling symlink) is treated the same as "not a
 * directory": loudly skipped via `logger.warn`, never enqueued, never
 * silently coerced or retried.
 *
 * This is a data-shape filter, not a new authorization gate — it decides
 * nothing about whether a directory may be MOUNTED (that is still
 * `fs:addRootByPath`'s two ordered gates, ruling S1); it only keeps a request
 * that can never succeed off the IPC channel.
 *
 * Sliced to `MAX_PENDING_OPEN_REQUESTS` BEFORE the sync `fs.statSync` loop,
 * not after: `enqueue` would drop anything past that ceiling anyway (oldest
 * first), so statting extra candidates is pure main-thread stall on a
 * runaway producer. `second-instance` argv is another PROCESS's input
 * (attacker-influencable, same framing as `folder-argv.ts`'s docblock) —
 * `brainstrike *` in a directory with tens of thousands of entries must not
 * block the main thread for that many synchronous stat syscalls before a
 * single request is enqueued.
 */
export function filterDirectoryOpenCandidates(
  candidates: readonly string[],
  origin: WorkspaceOpenOrigin
): readonly string[] {
  if (candidates.length > MAX_PENDING_OPEN_REQUESTS) {
    logger.warn('Truncated an oversized folder-open candidate list', {
      dropped: candidates.length - MAX_PENDING_OPEN_REQUESTS,
      origin,
    });
  }
  const directories: string[] = [];
  for (const candidate of candidates.slice(0, MAX_PENDING_OPEN_REQUESTS)) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        directories.push(candidate);
      } else {
        logger.warn('Skipped a non-directory folder-open candidate', { candidate, origin });
      }
    } catch (error) {
      logger.warn('Skipped an unreadable folder-open candidate', {
        candidate,
        error: error instanceof Error ? error.message : String(error),
        origin,
      });
    }
  }
  return directories;
}
