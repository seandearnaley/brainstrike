/**
 * Desktop AgentHookRunner over a HookManager.
 *
 * Adapts the manager's `HookEventResult` into the platform-neutral
 * `HookToolGateResult` the agent's `applyToolHooks` consumes. This closure runs
 * in the desktop MAIN process (the Mastra loop runs there); it is never
 * serialized over IPC/HTTP.
 */

import type { AgentHookRunner, HookToolGateResult } from '@brainstrike/agent';
import type { HookManager } from './manager';

export function createDesktopHookRunner(manager: HookManager): AgentHookRunner {
  return {
    async postToolUse(input: {
      toolName: string;
      toolInput: unknown;
      toolOutput: unknown;
      toolError: boolean;
    }): Promise<{ additionalContext?: string }> {
      const result = await manager.runPostToolUse(input);
      return result.additionalContext ? { additionalContext: result.additionalContext } : {};
    },
    async preToolUse(toolName: string, toolInput: unknown): Promise<HookToolGateResult> {
      const result = await manager.runPreToolUse(toolName, toolInput);
      if (result.allowed) {
        return {
          decision: 'allow',
          ...(result.additionalContext ? { additionalContext: result.additionalContext } : {}),
        };
      }
      return {
        decision: 'block',
        ...(result.blockReason ? { reason: result.blockReason } : {}),
      };
    },
  };
}
