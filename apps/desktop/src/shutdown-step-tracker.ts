import { type SerializedDesktopError, serializeDesktopError } from './desktop-error-serialization';

export interface ShutdownStepInFlight {
  readonly elapsedMs: number;
  readonly step: string;
}

export interface ShutdownStepTracker {
  /** The step currently awaiting completion, or null between steps. */
  describeInFlight(): ShutdownStepInFlight | null;
  /** Runs one ordered shutdown step; a rejection becomes a named failure record. */
  run(step: string, fn: () => Promise<void>): Promise<SerializedDesktopError | null>;
}

/**
 * Graceful shutdown runs its steps in a fixed order under one forced-exit
 * budget. When that budget fires, the only actionable fact is WHICH step was
 * still awaiting completion — every step is otherwise silent on success — so
 * the tracker records the in-flight step for the forced-exit log.
 */
export function createShutdownStepTracker(now: () => number = Date.now): ShutdownStepTracker {
  let inFlight: { readonly startedAt: number; readonly step: string } | null = null;
  return {
    describeInFlight: () =>
      inFlight ? { elapsedMs: now() - inFlight.startedAt, step: inFlight.step } : null,
    run: async (step, fn) => {
      inFlight = { startedAt: now(), step };
      try {
        await fn();
        return null;
      } catch (error) {
        return { step, ...serializeDesktopError(error) };
      } finally {
        inFlight = null;
      }
    },
  };
}
