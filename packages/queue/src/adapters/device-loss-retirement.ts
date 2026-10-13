/** Physical join used by the queue's existing pool owner after genuine GPU loss. */
export function joinDeviceLossRetirement(options: {
  readonly executions: ReadonlySet<Promise<unknown>>;
  readonly onFailure: (error: unknown) => Error;
  readonly onRetired: () => void;
  readonly terminate: () => PromiseLike<void>;
}): { readonly join: Promise<void>; readonly terminate: () => Promise<void> } {
  const retirement = Promise.withResolvers<void>();
  // Idle loss has no public request yet. Retain its rejection for the next admission.
  void retirement.promise.catch(() => undefined);
  const fail = (error: unknown): void => retirement.reject(options.onFailure(error));
  let physical: Promise<void> | null = null;
  const terminate = (): Promise<void> => {
    if (physical === null) {
      try {
        physical = Promise.resolve(options.terminate());
      } catch (error) {
        physical = Promise.reject(error);
      }
      void physical.catch(fail);
    }
    return physical;
  };
  void (async () => {
    // Include a synchronous event's own vendor execution before taking the snapshot.
    await Promise.resolve();
    await Promise.allSettled([...options.executions]);
    await terminate();
    options.onRetired();
  })().then(retirement.resolve, fail);
  return { join: retirement.promise, terminate };
}
