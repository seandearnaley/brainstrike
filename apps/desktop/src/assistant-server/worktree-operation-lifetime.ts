import {
  BoundaryFailureError,
  isBoundaryRefusal,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { HOST_LEASE_CLOSED } from '../desktop-shutdown-state';
import { gitRefused, gitThrew } from './git-failure';

/** Tracks complete service operations, including queued mutations and their final replies. */
export class WorktreeOperationLifetime {
  private readonly pending = new Set<Promise<BoundaryResult<unknown> | boolean>>();
  private readonly faults = new WeakMap<object, unknown>();
  private closing: Promise<void> | undefined;

  faultResult(cause: unknown): BoundaryResult<never> {
    const result = gitThrew(cause);
    if (!isBoundaryRefusal(cause)) {
      this.faults.set(result, cause);
    }
    return result;
  }

  track<T extends BoundaryResult<unknown> | boolean>(operation: () => Promise<T>): Promise<T> {
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

  admit<A extends unknown[], T>(operation: (...args: A) => Promise<BoundaryResult<T>>) {
    return (...args: A): Promise<BoundaryResult<T>> =>
      this.closing
        ? Promise.resolve(
            gitRefused(
              'availability',
              'worktree.service-closing',
              'The worktree service is closing.'
            )
          )
        : this.track(() => operation(...args));
  }

  prepareClose(): Promise<void> {
    this.closing ??= Promise.allSettled([...this.pending]).then((results) => {
      const failures = results.flatMap((result) => {
        if (result.status === 'rejected') {
          return [result.reason];
        }
        // An ordinary BoundaryResult refusal remains caller-owned. Only a caught
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
