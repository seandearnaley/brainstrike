import { type SerializedDesktopError, serializeDesktopError } from './desktop-error-serialization';

export interface ShutdownStepInFlight {
  readonly elapsedMs: number;
  readonly step: string;
}

export interface ShutdownStepDuration {
  readonly elapsedMs: number;
  readonly failed: boolean;
  readonly step: string;
}

export interface ShutdownStepTracker {
  /** Completed steps in order with their measured durations. */
  completed(): readonly ShutdownStepDuration[];
  /** The step currently awaiting completion, or null between steps. */
  describeInFlight(): ShutdownStepInFlight | null;
  /** Runs one ordered shutdown step; a rejection becomes a named failure record. */
  run(step: string, fn: () => Promise<void>): Promise<SerializedDesktopError | null>;
}

/**
 * Graceful shutdown runs its steps in a fixed order under one forced-exit
 * budget. When that budget fires, the only actionable fact is WHICH step was
 * still awaiting completion — every step is otherwise silent on success — so
 * the tracker records the in-flight step for the forced-exit log. Its single
 * in-flight slot assumes callers await each ordered run; concurrent steps are
 * not supported.
 */
export function createShutdownStepTracker(now: () => number = Date.now): ShutdownStepTracker {
  let inFlight: { readonly startedAt: number; readonly step: string } | null = null;
  const completed: ShutdownStepDuration[] = [];
  return {
    completed: () => [...completed],
    describeInFlight: () =>
      inFlight ? { elapsedMs: now() - inFlight.startedAt, step: inFlight.step } : null,
    run: async (step, fn) => {
      const startedAt = now();
      inFlight = { startedAt, step };
      let failed = false;
      try {
        await fn();
        return null;
      } catch (error) {
        failed = true;
        return { step, ...serializeDesktopError(error) };
      } finally {
        inFlight = null;
        completed.push({ elapsedMs: now() - startedAt, failed, step });
      }
    },
  };
}
