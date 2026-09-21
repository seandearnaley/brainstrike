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
 * The execution guard's budget for ONE call.
 *
 * A tool that declares an `executionBudget` is granted what its own contract
 * promises the model; a tool that declares none keeps the global default. The
 * declared budget deliberately ignores `defaultGuardMs`: that default exists
 * to bound tools with no deadline of their own, and letting it cap a declared
 * budget is the contradiction this ticket removes.
 */
export function resolveToolGuardBudgetMs(params: {
  budget: NativeToolExecutionBudget | undefined;
  defaultGuardMs: number;
  input: unknown;
}): number {
  const { budget, defaultGuardMs, input } = params;
  if (!budget) {
    return defaultGuardMs;
  }
  const requested = readRequestedTimeoutMs(input) ?? budget.defaultMs;
  return Math.min(requested, budget.maxMs) + TOOL_GUARD_MARGIN_MS;
}
