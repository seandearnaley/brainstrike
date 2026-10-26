// A failed startup is reported at once (ADR-0031: refuse, never wait). Its cleanup goes on, owned by
// that startup, and still holds the Root lock until it ends. The error the startup rejects with carries
// that cleanup as `released`, so an in-process caller that reopens the root joins it first.

/**
 * Carries `released` on `error`, keeping the error's own identity for every `instanceof` check. A
 * thrown value that is not an object is wrapped. `released` is marked handled here: its owner logs
 * a failure, and a caller that joins it still sees the rejection.
 */
export function withStartupRelease(error: unknown, released: Promise<void>): unknown {
  released.catch(() => undefined);
  const carrier =
    typeof error === 'object' && error !== null
      ? error
      : new Error(String(error), { cause: error });
  Object.defineProperty(carrier, 'released', { configurable: true, value: released });
  return carrier;
}

/**
 * The cleanup a failed startup left running: resolves once it released everything, Root lock
 * included; rejects when the cleanup failed and the root stays owned. Resolved for any other error.
 */
export function startupRelease(error: unknown): Promise<void> {
  const released =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'released') : undefined;
  return released instanceof Promise ? released.then(() => undefined) : Promise.resolve();
}
