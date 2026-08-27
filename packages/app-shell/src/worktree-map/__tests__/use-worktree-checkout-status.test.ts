/**
 * Pins the bound on simultaneous `checkoutStatus` reads. A bot finding on the
 * L1 PR flagged that each status read spawns two git subprocesses outside the
 * list mutex — an unbounded `Promise.all` over a 30-worktree Map would fork
 * 60 concurrent gits. `useWorktreeCheckoutStatuses`'s worker pool (see
 * `MAX_CONCURRENT_STATUS_READS` in `../use-worktree-checkout-status.ts`)
 * exists to prevent exactly that; this test proves the bound holds with
 * resolvable deferreds and a live in-flight counter, not just an assumption
 * about the pool size constant.
 */

import type { GitResult, WorktreeCheckoutStatus } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorktreesBridge } from '../../worktrees/worktrees-bridge';
import { useWorktreeCheckoutStatuses } from '../use-worktree-checkout-status';

/** The bound `use-worktree-checkout-status.ts` is written against. Duplicated
 * here (not imported) so the test still fails if someone raises the pool size
 * without updating this pin. */
const EXPECTED_BOUND = 4;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function statusFor(path: string): WorktreeCheckoutStatus {
  return { ahead: 0, behind: 0, clean: true, path, upstream: 'origin/main' };
}

describe('useWorktreeCheckoutStatuses concurrency bound', () => {
  it('never runs more checkoutStatus calls at once than the configured bound, across 10 pending paths', async () => {
    const paths = Array.from({ length: 10 }, (_, index) => `/repo-${index}`);
    const deferredsByPath = new Map(
      paths.map((path) => [path, deferred<GitResult<WorktreeCheckoutStatus>>()])
    );
    let inFlight = 0;
    let peakInFlight = 0;

    const checkoutStatus = vi.fn((params: { readonly path: string }) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const entry = deferredsByPath.get(params.path);
      if (!entry) {
        throw new Error(`No deferred registered for ${params.path}`);
      }
      return entry.promise.finally(() => {
        inFlight -= 1;
      });
    });
    const bridge = { checkoutStatus } as unknown as WorktreesBridge;

    const { result } = renderHook(() =>
      useWorktreeCheckoutStatuses({ bridge, paths, refreshNonce: 0 })
    );

    // The pool starts up to the bound immediately and must not start a
    // (bound + 1)th call while `bound` are still pending.
    await waitFor(() => expect(checkoutStatus).toHaveBeenCalledTimes(EXPECTED_BOUND));
    expect(peakInFlight).toBe(EXPECTED_BOUND);
    expect(inFlight).toBe(EXPECTED_BOUND);

    // Resolving one in-flight call frees exactly one pool slot; the next
    // queued path starts, but concurrency must never exceed the bound.
    const first = deferredsByPath.get('/repo-0');
    if (!first) {
      throw new Error('Missing deferred for /repo-0');
    }
    first.resolve({ ok: true, value: statusFor('/repo-0') });
    await waitFor(() => expect(checkoutStatus).toHaveBeenCalledTimes(EXPECTED_BOUND + 1));
    expect(peakInFlight).toBe(EXPECTED_BOUND);

    // Drain the remaining paths.
    for (const path of paths.slice(1)) {
      const entry = deferredsByPath.get(path);
      if (!entry) {
        throw new Error(`Missing deferred for ${path}`);
      }
      entry.resolve({ ok: true, value: statusFor(path) });
    }

    await waitFor(() =>
      expect(paths.every((path) => result.current.get(path)?.kind === 'ready')).toBe(true)
    );
    expect(checkoutStatus).toHaveBeenCalledTimes(paths.length);
    // The peak never exceeded the bound at any point across the whole run.
    expect(peakInFlight).toBe(EXPECTED_BOUND);
    expect(inFlight).toBe(0);
  });
});
