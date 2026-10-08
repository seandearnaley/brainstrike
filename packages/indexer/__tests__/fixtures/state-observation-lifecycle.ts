import { IndexerLifecycleError } from '@brainstrike/indexer';
import type { TestContext } from 'vitest';

interface OwnedResource {
  close(): Promise<unknown>;
  removal: boolean;
  value: unknown;
}

function retainedOwner(error: unknown): boolean {
  if (error instanceof IndexerLifecycleError) {
    return true;
  }
  if (error instanceof AggregateError) {
    return error.errors.some(retainedOwner);
  }
  return error instanceof Error && error.cause !== undefined && retainedOwner(error.cause);
}

/** Test-only ownership, registered by the caller before its first asynchronous acquisition. */
export class ObservationLifecycle {
  private retired = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly resources: OwnedResource[] = [];
  private readonly releases: Array<() => void> = [];
  private readonly unjoined: unknown[] = [];
  private primary: unknown;
  private retirement: Promise<void> | undefined;

  constructor(private readonly context: TestContext) {}

  check(): void {
    this.context.signal.throwIfAborted();
    if (this.retired) {
      throw new Error('Observation fixture admission is retired');
    }
  }

  /** Held inference/publication is released before teardown waits for admitted work. */
  releaseOnRetirement(release: () => void): void {
    this.check();
    this.releases.push(release);
  }

  private track<Value>(promise: Promise<Value>): Promise<Value> {
    this.pending.add(promise);
    promise.then(
      () => this.pending.delete(promise),
      (error: unknown) => {
        this.pending.delete(promise);
        if (retainedOwner(error)) {
          this.unjoined.push(error);
        }
      }
    );
    return promise;
  }

  work<Value>(start: () => Promise<Value> | Value): Promise<Value> {
    this.check();
    return this.track(
      Promise.resolve()
        .then(() => {
          this.check();
          return start();
        })
        .then((value) => {
          this.check();
          return value;
        })
    );
  }

  execute(body: () => Promise<void>): Promise<void> {
    const result = this.work(body);
    result.catch((error: unknown) => {
      this.primary ??= error;
    });
    return result;
  }

  /** Manual reopen and final teardown share the first physical retirement outcome. */
  closeResource(value: unknown): Promise<unknown> {
    this.check();
    const resource = this.resources.find((entry) => entry.value === value);
    if (!resource) {
      throw new TypeError('Observation fixture cannot retire an unowned resource');
    }
    return this.track(resource.close());
  }

  acquire<Value>(
    start: () => Promise<Value> | Value,
    close: (value: Value) => Promise<unknown> | unknown,
    options: { removal?: boolean; beforePublication?: (value: Value) => Promise<void> } = {}
  ): Promise<Value> {
    this.check();
    // Track before invoking start. A concrete late success is owned before publication/abort.
    return this.track(
      Promise.resolve()
        .then(() => {
          this.check();
          return start();
        })
        .then(async (value) => {
          let retirement: Promise<unknown> | undefined;
          this.resources.push({
            close: () => {
              retirement ??= Promise.resolve().then(() => close(value));
              return retirement;
            },
            removal: options.removal ?? false,
            value,
          });
          await options.beforePublication?.(value);
          this.check();
          return value;
        })
    );
  }

  /** A failed join is visible and never followed by Root removal or an automatic retry. */
  close(): Promise<void> {
    this.retired = true;
    this.retirement ??= this.join();
    return this.retirement;
  }

  private async join(): Promise<void> {
    const failures: unknown[] = [];
    for (const release of this.releases.splice(0).reverse()) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
    failures.push(...this.unjoined);
    const owned = [...this.resources].reverse();
    for (const resource of owned.filter((entry) => !entry.removal)) {
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0) {
      for (const resource of owned.filter((entry) => entry.removal)) {
        try {
          await resource.close();
        } catch (error) {
          failures.push(error);
          break;
        }
      }
    }
    if (failures.length > 0) {
      const primary = this.context.signal.aborted ? this.context.signal.reason : this.primary;
      throw new AggregateError(
        primary === undefined ? failures : [primary, ...failures],
        'Observation fixture failed to join; Root retained'
      );
    }
  }
}
