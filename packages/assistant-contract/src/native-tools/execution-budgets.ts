import type { NativeToolDefinition, NativeToolExecutionBudget } from './define.js';

/** Budgets keyed by canonical tool id; only tools that declare one appear. */
export function deriveNativeToolExecutionBudgets(
  tools: readonly NativeToolDefinition[]
): ReadonlyMap<string, NativeToolExecutionBudget> {
  const budgets = new Map<string, NativeToolExecutionBudget>();
  for (const tool of tools) {
    if (tool.executionBudget) {
      budgets.set(tool.id, tool.executionBudget);
    }
  }
  return budgets;
}

/**
 * The largest budget any native tool may be granted. Derived, never restated:
 * the stream watchdog's `tool-executing` backstop is sized from it, and a
 * second hand-maintained number is how BST-1777 happened.
 */
export function deriveMaxNativeToolExecutionBudgetMs(
  budgets: ReadonlyMap<string, NativeToolExecutionBudget>
): number {
  let max = 0;
  for (const budget of budgets.values()) {
    max = Math.max(max, budget.maxMs);
  }
  if (max === 0) {
    throw new Error(
      'No native tool declares an executionBudget; the watchdog backstop cannot be derived.'
    );
  }
  return max;
}
