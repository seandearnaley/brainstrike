import type { NativeToolExecutionBudget } from '@brainstrike/assistant-contract';

/**
 * Head start the tool's OWN deadline gets over the guard (BST-1777).
 *
 * A tool that enforces `timeoutMs` itself answers with a richer result than
 * the guard can (`timedOut: true` plus the captured output tail), so the guard
 * must lose that race. Sized for the slowest self-teardown: executeCommand's
 * SIGTERM -> SIGKILL grace (2000ms) plus pipe close.
 */
export const TOOL_GUARD_MARGIN_MS = 5000;

function readRequestedTimeoutMs(input: unknown): number | undefined {
  if (typeof input !== 'object' || input === null) {
    return;
  }
  const value = (input as { timeoutMs?: unknown }).timeoutMs;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * One call's budget, in the TWO numbers that are not the same thing.
 *
 * `grantedMs` is what the tool's contract promised the model for this call and
 * the only number the model may ever be told; `guardMs` is what the guard
 * waits, which adds {@link TOOL_GUARD_MARGIN_MS} purely so the tool's own
 * deadline wins the race. Reporting the guard window made `executeCommand`'s
 * documented 120000ms default surface to the model as "its 125s execution
 * budget", disagreeing with the tool's own description (PR review of
 * BST-1777).
 */
export interface ToolGuardBudget {
  /** The execution budget granted to this call; the margin is invisible here. */
  readonly grantedMs: number;
  /** The window the guard waits before giving up. */
  readonly guardMs: number;
}

/**
 * The execution guard's budget for ONE call — the SINGLE place this
 * arithmetic lives.
 *
 * A tool that declares an `executionBudget` is granted what its own contract
 * promises the model; a tool that declares none keeps the global default (and
 * gets no margin, because it has no deadline of its own to lose the race to).
 * The declared budget deliberately ignores `defaultGuardMs`: that default
 * exists to bound tools with no deadline of their own, and letting it cap a
 * declared budget is the contradiction this ticket removes.
 */
export function resolveToolGuardBudget(params: {
  budget: NativeToolExecutionBudget | undefined;
  defaultGuardMs: number;
  input: unknown;
}): ToolGuardBudget {
  const { budget, defaultGuardMs, input } = params;
  if (!budget) {
    return { grantedMs: defaultGuardMs, guardMs: defaultGuardMs };
  }
  const requested = readRequestedTimeoutMs(input) ?? budget.defaultMs;
  const grantedMs = Math.min(requested, budget.maxMs);
  return { grantedMs, guardMs: grantedMs + TOOL_GUARD_MARGIN_MS };
}
