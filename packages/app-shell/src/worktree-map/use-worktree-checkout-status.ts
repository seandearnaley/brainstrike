/**
 * Per-card `git status` for the Worktree Map, read LAZILY and at most once per
 * (path, invalidation generation).
 *
 * Deliberately not folded into `worktrees.list()`: that call also backs the
 * Mode chip's picker and runs on every refresh, and N status subprocesses
 * behind an orientation surface is the cost this seam exists to avoid (A3).
 * Concurrency is bounded so a workspace with twenty worktrees does not fork
 * twenty gits at once.
 */
import { createLogger } from '@brainstrike/logging';
import type { WorktreeCheckoutStatus } from '@brainstrike/types';
import { useEffect, useState } from 'react';
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';

const logger = createLogger('WorktreeCheckoutStatus');

/** Simultaneous `git status` reads. Four keeps a large workspace responsive
 * without saturating a laptop's process table. */
const MAX_CONCURRENT_STATUS_READS = 4;

export type WorktreeCheckoutStatusState =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: WorktreeCheckoutStatus };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readInBatches(
  bridge: WorktreesBridge,
  paths: readonly string[],
  onResult: (path: string, state: WorktreeCheckoutStatusState) => void,
  isCancelled: () => boolean
): Promise<void> {
  const queue = [...paths];
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_STATUS_READS, queue.length) },
    async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (isCancelled()) {
          return;
        }
        const path = next;
        try {
          const result = await bridge.checkoutStatus({ path });
          if (isCancelled()) {
            return;
          }
          onResult(
            path,
            result.ok
              ? { kind: 'ready', value: result.value }
              : { kind: 'error', message: result.error }
          );
        } catch (error) {
          logger.warn('worktree checkout status threw', { error, path });
          if (!isCancelled()) {
            onResult(path, { kind: 'error', message: errorMessage(error) });
          }
        }
      }
    }
  );
  await Promise.all(workers);
}

export function useWorktreeCheckoutStatuses(input: {
  readonly bridge: WorktreesBridge | null;
  readonly paths: readonly string[];
  readonly refreshNonce: number;
}): ReadonlyMap<string, WorktreeCheckoutStatusState> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, WorktreeCheckoutStatusState>>(
    new Map()
  );
  // Serialize the paths so the effect keys on CONTENT, not on array identity:
  // the list is rebuilt on every refresh and would otherwise re-read forever.
  // JSON rather than a delimiter join: a POSIX path may contain any byte except
  // NUL, so no separator character is safe, and a raw NUL in a source file is
  // banned in this repo.
  const pathKey = JSON.stringify(input.paths);
  const { bridge, refreshNonce } = input;

  useEffect(() => {
    // Round-trips a value THIS hook just serialized, so the cast is total.
    const paths = JSON.parse(pathKey) as readonly string[];
    let cancelled = false;

    // `.then()`, not a synchronous body: firing `setStatuses` in the SAME
    // tick as the effect body is exactly what `react-hooks/set-state-in-effect`
    // flags — matches `use-worktree-map.ts`'s `load` shape, deferring every
    // state update to a real microtask. `cancelled` is set by the cleanup
    // function below synchronously (before this microtask can run) if the
    // effect is torn down first, so a superseded run never calls setStatuses.
    void Promise.resolve().then(() => {
      if (cancelled) {
        return;
      }
      if (!bridge || paths.length === 0) {
        setStatuses(new Map());
        return;
      }
      setStatuses(new Map(paths.map((path) => [path, { kind: 'loading' } as const])));
      void readInBatches(
        bridge,
        paths,
        (path, state) => {
          setStatuses((previous) => {
            const next = new Map(previous);
            next.set(path, state);
            return next;
          });
        },
        () => cancelled
      );
    });

    return () => {
      cancelled = true;
    };
  }, [bridge, pathKey, refreshNonce]);

  return statuses;
}
