import { createContext, type ReactNode, use } from 'react';

/**
 * Derived last-24h budget posture for the composer burn-down + send gate.
 * All amounts are USD. `spentUsd` is the EXACT provider-reported portion and
 * `estimatedUsd` the registry-priced remainder — the chip renders their sum
 * against `capUsd`. `unpricedModelCount` counts models whose tokens are
 * EXCLUDED from the total because no list price exists; the UI must surface
 * that marker explicitly rather than fold a fabricated price into the total.
 */
export interface BudgetGuardrailStatus {
  readonly capUsd: number;
  readonly estimatedUsd: number;
  readonly overCap: boolean;
  readonly spentUsd: number;
  readonly unpricedModelCount: number;
}

export interface BudgetGuardrailContextValue {
  /** Session-scoped "Send anyway" acknowledgment; resets with the panel. */
  readonly overridden: boolean;
  /** Flip the session override so sending proceeds despite the cap. */
  readonly override: () => void;
  readonly status: BudgetGuardrailStatus;
}

/**
 * Capability-injection seam for the last-24h budget guardrail, PARALLEL to
 * RunVerdictContext by design: app-shell composes the persisted cap preference
 * with the durable spend derivation and provides the result; the UI package
 * renders nothing when the value is null (no cap configured, no durable-usage
 * capability, or spend not derivable) — capability gating, never a disabled
 * stub. Over-cap behavior is never silent in either direction: sending is
 * blocked with a visible notice + explicit override, and an active override is
 * stated next to the chip.
 */
const BudgetGuardrailContext = createContext<BudgetGuardrailContextValue | null>(null);

export function BudgetGuardrailProvider({
  value,
  children,
}: {
  value: BudgetGuardrailContextValue | null;
  children: ReactNode;
}) {
  return (
    <BudgetGuardrailContext.Provider value={value}>{children}</BudgetGuardrailContext.Provider>
  );
}

/**
 * The budget guardrail binding, or `null` when no provider supplied one —
 * capability gating, never a disabled stub.
 */
export function useBudgetGuardrailContext(): BudgetGuardrailContextValue | null {
  return use(BudgetGuardrailContext);
}
