import { HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET } from '@brainstrike/agent';
import type { HostRunHooks } from '@brainstrike/agent-host';
import { createLogger } from '@brainstrike/logging';
import { loadHooksConfig } from './config.js';
import { HookManager } from './manager.js';

const logger = createLogger('HostHooks');

export interface HostRunHooksOptions {
  /** The global hooks file; production passes `getGlobalHooksPath()`. */
  readonly globalPath: string;
  /**
   * The tool timeout: each hook's timeout must stay below it, and the bounded
   * phases (UserPromptSubmit, Stop) share it as their aggregate budget.
   */
  readonly maxHookTimeoutMs: number;
  /** The run's workspace roots, in mounted order; a project file runs only once trusted. */
  readonly roots: readonly {
    readonly absPath: string;
    readonly approvedSha256?: string;
    readonly rootId: string;
  }[];
  /** The hooks' `session_id`: the run's thread. */
  readonly sessionId: string;
}

/**
 * The composition's hooks for one run, shared by the desktop and CLI hosts:
 * global hooks run without approval; a project file contributes nothing until
 * its root's SHA-256 is trusted, and a skipped or malformed file is reported,
 * never thrown. Returns undefined when no hook is configured.
 */
export function createHostRunHooks(options: HostRunHooksOptions): HostRunHooks | undefined {
  const primaryCwd = options.roots[0]?.absPath ?? process.cwd();
  const load = loadHooksConfig({
    aggregateTimeoutMs: options.maxHookTimeoutMs,
    globalPath: options.globalPath,
    maxHookTimeoutMs: options.maxHookTimeoutMs,
    primaryRootCwd: primaryCwd,
    roots: options.roots.map((root) => ({
      absPath: root.absPath,
      rootId: root.rootId,
      ...(root.approvedSha256 === undefined ? {} : { approvedSha256: root.approvedSha256 }),
    })),
  });
  const manager = new HookManager(load, {
    aggregateTimeoutMs: options.maxHookTimeoutMs,
    logger,
    primaryCwd,
    sessionId: options.sessionId,
  });
  manager.reportConfigErrors();
  if (!manager.hasHooks()) {
    return;
  }
  return {
    matchesPreToolUse: (toolName) => manager.matchesPreToolUse(toolName),
    postToolUse: async ({ error, input, output, toolName }) => {
      const result = await manager.runPostToolUse({
        toolError: error,
        toolInput: input,
        toolName,
        toolOutput: output,
      });
      // A guarded error result keeps its own reading, as on the legacy path.
      return result.additionalContext && !error
        ? { additionalContext: boundedContext(result.additionalContext) }
        : {};
    },
    preToolUse: async ({ input, toolName }) => {
      const result = await manager.runPreToolUse(toolName, input);
      return result.allowed
        ? { blocked: false }
        : { blocked: true, reason: result.blockReason ?? `A PreToolUse hook blocked ${toolName}` };
    },
    stop: async ({ assistantMessage, reason }) => {
      const result = await manager.runStop(reason, assistantMessage);
      return result.runVerdict ? { verdict: result.runVerdict } : {};
    },
    userPromptSubmit: async (prompt) => {
      const result = await manager.runUserPromptSubmit(prompt);
      if (!result.allowed) {
        return {
          blocked: true,
          reason: result.blockReason ?? 'A UserPromptSubmit hook blocked it',
        };
      }
      return result.additionalContext
        ? { additionalContext: result.additionalContext, blocked: false }
        : { blocked: false };
    },
  };
}

/** PostToolUse context is bounded beside a tool result, as the legacy tool wrapper bounds it. */
function boundedContext(context: string): string {
  const points = Array.from(context);
  return points.length <= HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET
    ? context
    : `${points.slice(0, HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET - 1).join('')}…`;
}
