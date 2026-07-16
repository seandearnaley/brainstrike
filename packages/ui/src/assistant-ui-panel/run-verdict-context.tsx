import { createContext, type ReactNode, use } from 'react';

/** The user's judgment of a finished run's WORK (not its transport status). */
export type RunVerdictValue = 'failed' | 'succeeded';

export interface RunVerdictContextValue {
  /**
   * Record the user's verdict for a run (Task Ledger, `source: 'user'`). A user
   * verdict deliberately upserts over any derived `edit_revert` label. Rejects
   * on persistence failure — the control surfaces a visible retry, never a
   * silent drop.
   */
  readonly recordVerdict: (runId: string, verdict: RunVerdictValue) => Promise<void>;
}

/**
 * Capability-injection seam for run verdicts, PARALLEL to EditCheckpointContext
 * by design: verdicts gate on the renderer repository's optional
 * `recordRunOutcome` (present wherever the PGlite repo exists, including web),
 * while checkpoint reverts gate on the desktop IPC bridge. Folding them into
 * one context would wrongly suppress verdicts where reverts are unavailable.
 */
const RunVerdictContext = createContext<RunVerdictContextValue | null>(null);

export function RunVerdictProvider({
  value,
  children,
}: {
  value: RunVerdictContextValue | null;
  children: ReactNode;
}) {
  return <RunVerdictContext.Provider value={value}>{children}</RunVerdictContext.Provider>;
}

/**
 * The verdict binding, or `null` when no provider supplied one — capability
 * gating, never a disabled stub.
 */
export function useRunVerdictContext(): RunVerdictContextValue | null {
  return use(RunVerdictContext);
}
