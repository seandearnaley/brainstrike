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
 * Bind a lookup-or-throw for one derived budget map (BST-1777 final review,
 * minor 1). Three call sites each hand-rolled their own "get this tool's
 * budget or throw" — `execute-command-tool.ts`'s `requireExecutionBudget`,
 * `run-python-approval-context.ts`'s `requireRunPythonDefaultTimeoutMs`, and
 * `run-skill-script-tool.ts` importing the first ACROSS tools — the kind of
 * accidental coupling that makes the next split painful. A factory rather
 * than a bare function here: this module cannot import
 * `NATIVE_TOOL_EXECUTION_BUDGETS` without a cycle (`native-tools/index.ts`
 * imports this module to derive it), so the map is bound at the call site
 * instead.
 */
export function requireNativeToolExecutionBudgetFactory(
  budgets: ReadonlyMap<string, NativeToolExecutionBudget>
): (toolId: string) => NativeToolExecutionBudget {
  return (toolId: string): NativeToolExecutionBudget => {
    const budget = budgets.get(toolId);
    if (!budget) {
      throw new Error(`Native tool ${toolId} declares no executionBudget.`);
    }
    return budget;
  };
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
