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

/** Host authority; counters are keyed by observed native child and original root turn. */
export interface DelegatedBudgetPort {
  reserveStep(scope: { threadId: string; resourceId: string }): Promise<DelegatedStepReservation>;
  settleStep(reservationId: string, outputTokens: number | undefined): Promise<void>;
}
