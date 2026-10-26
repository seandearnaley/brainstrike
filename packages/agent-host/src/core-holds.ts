/** The work holding a host open, counted where it is retained. */
export interface HostHolds {
  /** Counts work Core alone waits on, such as a pending wake; it never refuses. */
  hold(): () => void;
  /** Settles once nothing holds the host. */
  idle(): Promise<void>;
  /** Counts a run, child or recovered run, which also retains the runtime. */
  retain(): () => void;
}
/**
 * Runs, children, recovered runs and pending wakes each hold the host; this
 * counts them as they do, so its opener can wait for quiet.
 */
export function countHostHolds(retainRun: () => () => void): HostHolds {
  let held = 0;
  let quiet = Promise.withResolvers<void>();
  quiet.resolve();
  const hold = (release: () => void): (() => void) => {
    if (held === 0) {
      quiet = Promise.withResolvers<void>();
    }
    held += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      release();
      held -= 1;
      if (held === 0) {
        quiet.resolve();
      }
    };
  };
  return {
    hold: () => hold(() => undefined),
    idle: () => quiet.promise,
    retain: () => hold(retainRun()),
  };
}
