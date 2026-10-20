import {
  BoundaryFailureError,
  isBoundaryRefusal,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { GitResult } from '@brainstrike/types';
import { HOST_LEASE_CLOSED } from '../desktop-shutdown-state';
import { toErrorMessage } from './git-service';

/** Tracks complete service operations, including queued mutations and their final replies. */
export class WorktreeOperationLifetime {
  private readonly pending = new Set<Promise<GitResult<unknown> | boolean>>();
  private readonly faults = new WeakMap<object, unknown>();
  private closing: Promise<void> | undefined;

  faultResult(cause: unknown): GitResult<never> {
    const result = { error: toErrorMessage(cause), ok: false } as const;
    if (!isBoundaryRefusal(cause)) {
      this.faults.set(result, cause);
    }
    return result;
  }

  track<T extends GitResult<unknown> | boolean>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new BoundaryFailureError(HOST_LEASE_CLOSED));
    }
    const task = Promise.resolve().then(operation);
    this.pending.add(task);
    const settled = (): void => {
      this.pending.delete(task);
    };
    void task.then(settled, settled);
    return task;
  }

  admit<A extends unknown[], T>(operation: (...args: A) => Promise<GitResult<T>>) {
    return (...args: A): Promise<GitResult<T>> =>
      this.closing
        ? Promise.resolve({ error: 'The worktree service is closing.', ok: false })
        : this.track(() => operation(...args));
  }

  prepareClose(): Promise<void> {
    this.closing ??= Promise.allSettled([...this.pending]).then((results) => {
      const failures = results.flatMap((result) => {
        if (result.status === 'rejected') {
          return [result.reason];
        }
        // An ordinary GitResult refusal remains caller-owned. Only a caught
        // execution fault retains its original cause for terminal preparation.
        return typeof result.value === 'object' && this.faults.has(result.value)
          ? [this.faults.get(result.value)]
          : [];
      });
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Worktree operations failed during close preparation');
      }
    });
    return this.closing;
  }
}
