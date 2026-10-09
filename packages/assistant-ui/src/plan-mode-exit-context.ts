import { createContext, use } from 'react';

/**
 * Callback that clears the persisted plan-mode toggle. Provided by the
 * data-stream runtime and consumed by the plan-submission notice so APPROVING
 * a plan exits plan mode BEFORE the resume request is composed — the rebuilt
 * server runtime then omits `planMode` and unlocks the mutation tools. REJECT
 * leaves plan mode on so the model can revise. `null` when plan mode is not
 * wired (e.g. non-desktop transports).
 */
export const PlanModeExitContext = createContext<(() => void) | null>(null);

export function usePlanModeExit(): (() => void) | null {
  return use(PlanModeExitContext);
}
