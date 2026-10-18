/**
 * Waits for work another owner holds (the auth engine's shared refresh, a
 * credential store read). An abort releases only this caller, with its
 * reason, and never cancels that work: other callers and the owner rely on it.
 */
export async function leaveOnAbort<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await start();
  }
  signal.throwIfAborted();
  const work = start();
  const left = Promise.withResolvers<never>();
  const leave = (): void => left.reject(signal.reason);
  signal.addEventListener('abort', leave, { once: true });
  try {
    return await Promise.race([work, left.promise]);
  } finally {
    signal.removeEventListener('abort', leave);
  }
}

interface Flight<T> {
  readonly controller: AbortController;
  readonly result: Promise<T>;
  waiters: number;
}

/**
 * Single-flight work per key, cancellable per caller (BST-2174). A caller whose
 * signal aborts stops waiting with that signal's reason; the shared work aborts
 * only when no caller is left waiting, so one caller's cancel never fails another.
 */
export function createSharedFlights<T>(): (
  key: string,
  start: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
) => Promise<T> {
  const flights = new Map<string, Flight<T>>();
  const forget = (key: string, flight: Flight<T>): void => {
    if (flights.get(key) === flight) {
      flights.delete(key);
    }
  };
  return async (key, start, signal) => {
    signal?.throwIfAborted();
    let flight = flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const created: Flight<T> = { controller, result: start(controller.signal), waiters: 0 };
      const settled = (): void => forget(key, created);
      created.result.then(settled, settled);
      flights.set(key, created);
      flight = created;
    }
    const joined = flight;
    joined.waiters += 1;
    if (!signal) {
      try {
        return await joined.result;
      } finally {
        joined.waiters -= 1;
      }
    }
    const abandoned = Promise.withResolvers<never>();
    let waiting = true;
    const abandon = (): void => {
      waiting = false;
      joined.waiters -= 1;
      if (joined.waiters === 0) {
        // A later caller starts afresh rather than joining the aborted work.
        forget(key, joined);
        joined.controller.abort(signal.reason);
      }
      abandoned.reject(signal.reason);
    };
    signal.addEventListener('abort', abandon, { once: true });
    try {
      return await Promise.race([joined.result, abandoned.promise]);
    } finally {
      signal.removeEventListener('abort', abandon);
      if (waiting) {
        joined.waiters -= 1;
      }
    }
  };
}
