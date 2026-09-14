/** Host-owned limits for one original root turn, including resumes and descendants. */
export const DELEGATION_LIMITS = Object.freeze({
  maxChildOutputTokens: 32_768,
  maxChildSteps: 16,
  maxConcurrentWork: 2,
  maxDepth: 3,
  maxInvocations: 8,
  maxStepOutputTokens: 8192,
  maxTreeOutputTokens: 131_072,
  synthesisOutputTokens: 512,
});

export interface DelegatedStepReservation {
  readonly id: string;
  readonly outputTokens: number;
  readonly synthesis: boolean;
}

/** The host's answer at delegation START, before any native child exists. */
export type DelegatedInvocationAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string };

/** Host authority; counters are keyed by observed native child and original root turn. */
export interface DelegatedBudgetPort {
  /**
   * Refuse an invocation the durable tree budget cannot admit (depth,
   * invocations, output) BEFORE Mastra starts the child, so the delegation
   * returns a rejection the model can read instead of failing the root once
   * the child binds. Admission at persist time remains the authority; this is
   * the early answer for the common case.
   */
  admitInvocation(scope: {
    parentThreadId: string;
    parentResourceId: string;
  }): Promise<DelegatedInvocationAdmission>;
  reserveStep(scope: { threadId: string; resourceId: string }): Promise<DelegatedStepReservation>;
  settleStep(reservationId: string, outputTokens: number | undefined): Promise<void>;
}
