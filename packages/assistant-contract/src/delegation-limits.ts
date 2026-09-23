/*
 * Delegation budget TYPES. The limits themselves — tree and per-child — are
 * user settings (`RuntimeSubagentSettings`, `subagent-settings.ts`). There is
 * deliberately no limits constant here: a consumer reading one instead of the
 * request's settings would be a compile error.
 */

/** Which durable cap forced a child's reserved synthesis step. */
export type DelegationBudgetCap = 'steps' | 'child-output' | 'tree-output';

/**
 * A synthesis reservation names the cap that forced it and the numbers behind
 * it (`used` of `limit` in that cap's unit: steps, or output tokens) so the
 * `delegation.budget.exhausted` run event can state them without a second
 * read of the budget rows.
 */
export type DelegatedStepReservation =
  | { readonly id: string; readonly outputTokens: number; readonly synthesis: false }
  | {
      readonly cap: DelegationBudgetCap;
      readonly id: string;
      readonly limit: number;
      readonly outputTokens: number;
      readonly synthesis: true;
      readonly used: number;
    };

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

/** Usage was committed before rejecting further execution for this reservation. */
export class DelegatedOutputReservationExceededError extends Error {
  constructor() {
    super('Provider exceeded the delegated output reservation; tool execution rejected.');
    this.name = 'DelegatedOutputReservationExceededError';
  }
}
