import { describe, expect, it } from 'vitest';
import {
  defineNativeTool,
  InvalidNativeToolDefinitionError,
  MAX_NATIVE_TOOL_EXECUTION_BUDGET_MS,
  NATIVE_TOOL_EXECUTION_BUDGETS,
  NATIVE_TOOL_ID,
  NATIVE_TOOLS,
  requireNativeToolExecutionBudget,
} from '../index.js';
import { executeCommand } from '../native-tools/definitions/execute-command.js';

describe('native tool execution budgets', () => {
  it('declares the three tools whose input carries timeoutMs', () => {
    expect(Object.fromEntries(NATIVE_TOOL_EXECUTION_BUDGETS)).toEqual({
      [NATIVE_TOOL_ID.executeCommand]: { defaultMs: 120_000, maxMs: 600_000 },
      [NATIVE_TOOL_ID.runPython]: { defaultMs: 30_000, maxMs: 600_000 },
      [NATIVE_TOOL_ID.runSkillScript]: { defaultMs: 120_000, maxMs: 600_000 },
    });
  });

  it('derives the largest budget instead of restating it', () => {
    expect(MAX_NATIVE_TOOL_EXECUTION_BUDGET_MS).toBe(600_000);
  });

  // The schema is what the MODEL is told; the budget is what the guard grants.
  // They disagreeing is the BST-1777 bug, so the agreement is pinned per tool.
  it.each([...NATIVE_TOOL_EXECUTION_BUDGETS])(
    '%s: the input schema accepts maxMs and rejects maxMs + 1',
    (toolId, budget) => {
      // Read off the tool's OWN definition: NATIVE_TOOL_INPUT_SCHEMAS lives in
      // @brainstrike/agent, and this browser-safe package must not depend upward.
      const definition = NATIVE_TOOLS.find((tool) => tool.id === toolId);
      if (!definition) {
        throw new Error(`No native tool definition for ${toolId}`);
      }
      const schema = definition.inputSchema;
      const base = toolId === NATIVE_TOOL_ID.executeCommand ? { command: 'true' } : {};
      const atMax = schema.safeParse({ ...base, timeoutMs: budget.maxMs });
      const overMax = schema.safeParse({ ...base, timeoutMs: budget.maxMs + 1 });
      // Only the timeoutMs verdict is asserted: other required fields differ per tool.
      const timeoutIssue = (result: typeof atMax): boolean =>
        !result.success && result.error.issues.some((issue) => issue.path[0] === 'timeoutMs');
      expect(timeoutIssue(atMax)).toBe(false);
      expect(timeoutIssue(overMax)).toBe(true);
    }
  );

  it('rejects a budget whose default exceeds its max', () => {
    expect(() =>
      defineNativeTool({ ...executeCommand, executionBudget: { defaultMs: 10, maxMs: 5 } })
    ).toThrow(InvalidNativeToolDefinitionError);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a non-positive-integer budget (%s)', (bad) => {
    expect(() =>
      defineNativeTool({ ...executeCommand, executionBudget: { defaultMs: bad, maxMs: 600_000 } })
    ).toThrow(InvalidNativeToolDefinitionError);
  });

  describe('requireNativeToolExecutionBudget', () => {
    it('returns the budget for a known id', () => {
      expect(requireNativeToolExecutionBudget(NATIVE_TOOL_ID.executeCommand)).toEqual({
        defaultMs: 120_000,
        maxMs: 600_000,
      });
    });

    it('throws for an id with no declared executionBudget', () => {
      expect(() => requireNativeToolExecutionBudget('not-a-real-tool')).toThrow(
        'Native tool not-a-real-tool declares no executionBudget.'
      );
    });
  });
});
