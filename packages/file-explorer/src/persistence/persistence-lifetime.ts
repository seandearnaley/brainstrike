/** Completion ownership for one store's existing persistence operations. */
export class PersistenceLifetime {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly hydrations = new Set<Promise<void>>();
  private preparing = false;
  private observingClose = false;
  private drains = 0;
  private readonly closeFailures = new Set<unknown>();
  private preparation: Promise<void> | undefined;

  constructor(private readonly flush: () => Promise<unknown>) {}

  beginHydration(): (error?: unknown) => void {
    if (this.preparing) {
      throw new Error('Explorer persistence is preparing to close');
    }
    const completion = Promise.withResolvers<void>();
    // Middleware merge/recovery publication follows the raw getItem promise.
    // Retain the whole accepted hydration in this same store lifetime.
    const hydration = this.run(() => completion.promise);
    this.hydrations.add(hydration);
    const settled = () => {
      this.hydrations.delete(hydration);
    };
    void hydration.then(settled, settled);
    return (error) => {
      if (error === undefined) {
        completion.resolve();
      } else {
        completion.reject(error);
      }
    };
  }

  async drainHydration(): Promise<void> {
    const results: PromiseSettledResult<void>[] = [];
    do {
      results.push(...(await Promise.allSettled([...this.hydrations])));
    } while (this.hydrations.size > 0);
    throwFailures(results);
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.preparing) {
      return Promise.reject(new Error('Explorer persistence is preparing to close'));
    }
    const completion = (async () => await operation())();
    this.pending.add(completion);
    void completion.then(
      () => this.pending.delete(completion),
      (error: unknown) => {
        if (this.observingClose) {
          this.closeFailures.add(error);
        }
        this.pending.delete(completion);
      }
    );
    return completion;
  }

  async joinWrite(completion: unknown): Promise<void> {
    if (!this.preparing && this.drains === 0) {
      await completion;
      return;
    }
    // Already admitted work can finish a hydration read after preparation starts.
    throwFailures(await Promise.allSettled([completion, this.flush()]));
  }

  async drain(): Promise<void> {
    this.drains += 1;
    const failures = new Set<unknown>();
    try {
      do {
        const results = await Promise.allSettled([...this.pending, this.flush()]);
        for (const result of results) {
          if (result.status === 'rejected') {
            failures.add(result.reason);
          }
        }
      } while (this.pending.size > 0);
      for (const failure of this.closeFailures) {
        failures.add(failure);
      }
    } finally {
      this.drains -= 1;
    }
    throwFailures([...failures].map((reason) => ({ reason, status: 'rejected' as const })));
  }

  beginCloseObservation(): void {
    this.observingClose = true;
  }

  prepareClose(): Promise<void> {
    this.beginCloseObservation();
    this.preparing = true;
    this.preparation ??= this.drain();
    return this.preparation;
  }
}

function throwFailures(results: readonly PromiseSettledResult<unknown>[]): void {
  const failures = [
    ...new Set(results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))),
  ];
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Explorer persistence failed to settle');
  }
}
