/** The work holding a host open, counted where it is retained. */
export interface HostHolds {
  /** Settles once nothing holds the host. */
  idle(): Promise<void>;
  retain(): () => void;
}
/**
 * Runs, children, recovered runs and pending wakes each retain the host's
 * runtime; this counts them as they do, so its opener can wait for quiet.
 */
export function countHostHolds(retainRun: () => () => void): HostHolds {
  let held = 0;
  let quiet = Promise.withResolvers<void>();
  quiet.resolve();
  return {
    idle: () => quiet.promise,
    retain: () => {
      const release = retainRun();
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
    },
  };
}
