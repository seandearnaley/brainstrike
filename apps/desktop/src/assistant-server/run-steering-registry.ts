import type { AssistantRunSteeringControl } from '@brainstrike/assistant-contract';

/**
 * Process-local registry of steerable in-flight runs (BST-588).
 *
 * The desktop assistant server registers every streaming leg that has a runId;
 * a later `/assistant/steer` POST flips the run's control so the agent loop
 * ends gracefully at the next step boundary. Mirrors the module-level pool
 * pattern of `execute-command-tool`'s liveChildProcesses. In-memory only —
 * a restart forgets in-flight runs, which is correct (their streams died with
 * the process).
 */

interface RunSteeringEntry {
  stopRequested: boolean;
}

const steerableRuns = new Map<string, RunSteeringEntry>();

/**
 * Register a run and hand back the control the agent loop polls. The control
 * closes over the entry, so a steer requested before unregister stays visible
 * to the in-flight loop even after the registry forgets the run.
 */
export function registerSteerableRun(runId: string): AssistantRunSteeringControl {
  if (steerableRuns.has(runId)) {
    throw new Error(`Steerable run already registered: ${runId}`);
  }
  const entry: RunSteeringEntry = { stopRequested: false };
  steerableRuns.set(runId, entry);
  return {
    stopRequested: () => entry.stopRequested,
  };
}

export function unregisterSteerableRun(runId: string): void {
  steerableRuns.delete(runId);
}

/**
 * Request a graceful stop for an active run. Returns false when the run is
 * unknown (already finished, never registered, or a stale id) so the endpoint
 * can answer with a visible 404 instead of pretending success.
 */
export function requestRunSteer(runId: string): boolean {
  const entry = steerableRuns.get(runId);
  if (!entry) {
    return false;
  }
  entry.stopRequested = true;
  return true;
}

/** Test-only: forget every registered run. */
export function resetRunSteeringRegistry(): void {
  steerableRuns.clear();
}
