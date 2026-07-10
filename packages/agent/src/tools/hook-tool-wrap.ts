/**
 * Compose tool-lifecycle hooks into the tool-execute seam.
 *
 * `applyToolHooks` is a SIBLING of `applyToolGuards`, composed OUTSIDE the guard
 * (`combinedTools → applyToolGuards → applyToolHooks → permission gate`). Each
 * tool's `execute` is clone-wrapped (same idiom as the guard) so a PreToolUse
 * hook runs BEFORE `execute` (and may block it) and a PostToolUse hook runs
 * AFTER (and may append bounded `additionalContext`).
 *
 * Fail-safe: an error thrown by the hook runner itself never crashes the tool —
 * it is logged and treated as ALLOW (a runner bug must not brick tool calling;
 * the block path is an explicit decision, not an exception).
 */

import { isGuardedToolError } from './guard-tool-execution';
import {
  type AgentHookRunner,
  HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET,
  type HookBlockedToolError,
} from './hook-runner';
import type { ToolLogger } from './types';

interface ExecutableLike {
  execute: (...args: unknown[]) => unknown;
}

function hasExecute(tool: unknown): tool is ExecutableLike {
  return typeof (tool as { execute?: unknown }).execute === 'function';
}

function capContext(context: string): string {
  if (context.length <= HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET) {
    return context;
  }
  return `${context.slice(0, HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET)}…`;
}

/**
 * Merge PostToolUse `additionalContext` into a tool result within the budget:
 * an object result gains a `hookAdditionalContext` field; a primitive result is
 * wrapped as `{ value, hookAdditionalContext }`. A guarded-error result is left
 * untouched (never annotate a failure).
 */
function mergeAdditionalContext(result: unknown, context: string): unknown {
  if (isGuardedToolError(result)) {
    return result;
  }
  const capped = capContext(context);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), hookAdditionalContext: capped };
  }
  return { hookAdditionalContext: capped, value: result };
}

export interface ApplyToolHooksOptions {
  readonly hookRunner: AgentHookRunner;
  readonly logger?: ToolLogger;
  /** Maps the Mastra-sanitized tool id → the user-facing name matchers use. */
  readonly toolNameMap: ReadonlyMap<string, string>;
}

function extractToolInput(args: readonly unknown[]): unknown {
  const first = args[0] as { context?: unknown } | undefined;
  return first && typeof first === 'object' && 'context' in first ? first.context : first;
}

function buildBlockedResult(toolName: string, reason: string | undefined): HookBlockedToolError {
  return {
    error: {
      code: 'tool_blocked_by_hook',
      message: reason ?? `Blocked by a PreToolUse hook: ${toolName}`,
      toolName,
    },
    ok: false,
    ...(reason ? { reason } : {}),
  };
}

/** Run the PreToolUse hook; returns a block result to short-circuit, else undefined. */
async function runPreHook(
  runner: AgentHookRunner,
  toolName: string,
  toolInput: unknown,
  logger?: ToolLogger
): Promise<HookBlockedToolError | undefined> {
  try {
    const pre = await runner.preToolUse(toolName, toolInput);
    if (pre.decision === 'block') {
      return buildBlockedResult(toolName, pre.reason);
    }
  } catch (error) {
    logger?.error('PreToolUse hook runner threw; allowing tool', { error, toolName });
  }
  return;
}

/** Run the PostToolUse hook; returns the (possibly context-merged) result. */
async function runPostHook(
  runner: AgentHookRunner,
  toolName: string,
  toolInput: unknown,
  result: unknown,
  logger?: ToolLogger
): Promise<unknown> {
  try {
    const post = await runner.postToolUse({
      toolError: isGuardedToolError(result),
      toolInput,
      toolName,
      toolOutput: result,
    });
    if (post.additionalContext) {
      return mergeAdditionalContext(result, post.additionalContext);
    }
  } catch (error) {
    logger?.error('PostToolUse hook runner threw; keeping tool result', { error, toolName });
  }
  return result;
}

export function applyToolHooks<TMap extends Record<string, unknown>>(
  tools: TMap,
  opts: ApplyToolHooksOptions
): TMap {
  const { hookRunner, toolNameMap, logger } = opts;
  const hooked: Record<string, unknown> = {};

  for (const [toolId, tool] of Object.entries(tools)) {
    if (!hasExecute(tool)) {
      hooked[toolId] = tool;
      continue;
    }
    const originalName = toolNameMap.get(toolId) ?? toolId;
    const original = tool.execute;

    const cloned = Object.create(Object.getPrototypeOf(tool)) as ExecutableLike;
    Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));

    cloned.execute = async (...args: unknown[]): Promise<unknown> => {
      const toolInput = extractToolInput(args);

      const blocked = await runPreHook(hookRunner, originalName, toolInput, logger);
      if (blocked) {
        return blocked;
      }

      const result = await Reflect.apply(original, cloned, args);
      return runPostHook(hookRunner, originalName, toolInput, result, logger);
    };

    hooked[toolId] = cloned;
  }

  return hooked as TMap;
}
