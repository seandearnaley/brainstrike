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

import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import type {
  ToolPayloadTransform,
  ToolPayloadTransformContext,
  ToolPayloadTransformTarget,
  ToolPayloadTransformTargetConfig,
} from '@mastra/core/tools';
import { isGuardedToolError } from './guard-tool-execution';
import {
  type AgentHookRunner,
  createHookResultEnvelope,
  HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET,
  type HookBlockedToolError,
  readHookResultEnvelope,
} from './hook-runner';
import { readToolCallId } from './read-tool-call-id';
import type { ToolExecutionDurations } from './tool-execution-durations';
import type { ToolLogger } from './types';

interface ExecutableLike {
  execute: (...args: unknown[]) => unknown;
  transform?: ToolPayloadTransform;
}

function hasExecute(tool: unknown): tool is ExecutableLike {
  return typeof (tool as { execute?: unknown }).execute === 'function';
}

function capContext(context: string): string {
  const capped = sliceCodePoints(context, HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET);
  if (capped.length === context.length) {
    return context;
  }
  return `${sliceCodePoints(context, HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET - 1)}…`;
}

/**
 * Carry PostToolUse `additionalContext` beside the original result in one
 * explicitly discriminated internal envelope. Every successful result shape
 * uses the same protocol, so the projection layer never guesses based on a
 * domain-owned field. A guarded-error result is left untouched.
 */
function mergeAdditionalContext(result: unknown, context: string): unknown {
  if (isGuardedToolError(result)) {
    return result;
  }
  const capped = capContext(context);
  return createHookResultEnvelope(result, capped);
}

function passthroughTransform(
  phase: keyof ToolPayloadTransformTargetConfig
): (context: ToolPayloadTransformContext) => unknown {
  switch (phase) {
    case 'approval':
    case 'input':
      return (context) => context.input;
    case 'error':
      return (context) => context.error;
    case 'inputDelta':
      return (context) => context.inputTextDelta;
    case 'output':
      return (context) => context.output;
    case 'resume':
      return (context) => context.resumeData;
    case 'suspend':
      return (context) => context.suspendPayload;
    default:
      throw new TypeError(`Unsupported tool payload transform phase: ${String(phase)}`);
  }
}

function createTargetTransform(
  existing: ToolPayloadTransformTargetConfig | undefined
): ToolPayloadTransformTargetConfig {
  const output = existing?.output;
  if (existing) {
    return {
      ...existing,
      output: (context) => {
        const envelope = readHookResultEnvelope(context.output);
        const domainOutput = envelope ? envelope.result : context.output;
        if (!output) {
          // Preserve Mastra's safe-placeholder behavior for an intentionally
          // configured target that omitted its output transform.
          return;
        }
        return output({ ...context, output: domainOutput });
      },
    };
  }
  return {
    approval: passthroughTransform('approval'),
    error: passthroughTransform('error'),
    input: passthroughTransform('input'),
    inputDelta: passthroughTransform('inputDelta'),
    output: (context) => {
      const envelope = readHookResultEnvelope(context.output);
      return envelope ? envelope.result : context.output;
    },
    resume: passthroughTransform('resume'),
    suspend: passthroughTransform('suspend'),
  };
}

/**
 * Mastra's target-aware payload transform is the raw/model split for hook
 * carriers: the live display and persisted transcript receive the exact domain
 * result, while `toModelOutput` still receives the internal carrier.
 */
function createHookPayloadTransform(
  existing: ToolPayloadTransform | undefined
): ToolPayloadTransform {
  const targets: readonly ToolPayloadTransformTarget[] = ['display', 'transcript'];
  return Object.fromEntries(
    targets.map((target) => [target, createTargetTransform(existing?.[target])])
  ) as ToolPayloadTransform;
}

export interface ApplyToolHooksOptions {
  /**
   * Records execution time for calls that never reach the guard.
   *
   * This wrapper composes OUTSIDE `guardToolExecution`, so a PreToolUse BLOCK
   * returns without invoking the guarded `execute` — and the guard is where the
   * measurement normally happens. Without an entry here the consumer falls back
   * to the `tool.started` → terminal timestamp gap, which for an approval-gated
   * call reports the whole human approval wait as execution time.
   *
   * Only the SHORT-CIRCUIT is recorded. An allowed call passes through to the
   * guard, whose measurement of the real work must not be overwritten by this
   * wrapper's overhead.
   */
  readonly durations?: ToolExecutionDurations;
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
  let additionalContext: string | undefined;
  try {
    const post = await runner.postToolUse({
      toolError: isGuardedToolError(result),
      toolInput,
      toolName,
      toolOutput: result,
    });
    additionalContext = post.additionalContext;
  } catch (error) {
    logger?.error('PostToolUse hook runner threw; keeping tool result', { error, toolName });
    return result;
  }
  if (!additionalContext) {
    return result;
  }
  if (result === undefined) {
    throw new TypeError(
      `${toolName} returned undefined and cannot carry PostToolUse context; tools must return a JSON-serializable result`
    );
  }
  return mergeAdditionalContext(result, additionalContext);
}

export function applyToolHooks<TMap extends Record<string, unknown>>(
  tools: TMap,
  opts: ApplyToolHooksOptions
): TMap {
  const { hookRunner, toolNameMap, logger, durations } = opts;
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
    Object.defineProperty(cloned, 'transform', {
      configurable: true,
      enumerable: true,
      value: createHookPayloadTransform(tool.transform),
      writable: true,
    });

    cloned.execute = async (...args: unknown[]): Promise<unknown> => {
      const toolInput = extractToolInput(args);
      const startedAt = performance.now();

      const blocked = await runPreHook(hookRunner, originalName, toolInput, logger);
      if (blocked) {
        // The tool never ran, so this is the hook's own elapsed time — small by
        // construction, and honest. The alternative is no entry at all, which
        // makes the consumer fall back to a gap spanning the approval wait.
        const toolCallId = readToolCallId(args);
        if (durations && toolCallId) {
          durations.record(toolCallId, performance.now() - startedAt);
        }
        return blocked;
      }

      const result = await Reflect.apply(original, cloned, args);
      return runPostHook(hookRunner, originalName, toolInput, result, logger);
    };

    hooked[toolId] = cloned;
  }

  return hooked as TMap;
}
