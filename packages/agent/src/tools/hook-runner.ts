/**
 * Tool-lifecycle hook runner contract (platform-neutral — NO node imports).
 *
 * The agent package composes hooks into the tool-execute seam via
 * {@link AgentHookRunner}; the desktop server supplies the concrete
 * implementation over its Node-only HookManager. Hooks REFINE, never widen:
 * a PreToolUse hook can BLOCK an already-permitted tool but can never allow a
 * denied/ask tool (the permission gate runs upstream of `execute`).
 */

export interface HookToolGateResult {
  readonly additionalContext?: string;
  readonly decision: 'allow' | 'block';
  readonly reason?: string;
}

export interface AgentHookRunner {
  postToolUse(input: {
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly toolOutput: unknown;
    readonly toolError: boolean;
  }): Promise<{ readonly additionalContext?: string }>;
  preToolUse(toolName: string, toolInput: unknown): Promise<HookToolGateResult>;
}

/**
 * The structured result returned in place of a tool's output when a PreToolUse
 * hook blocks it. Recognized by `isGuardedToolError` (shared `error.code`
 * union) so the untouched tool-event mapper renders it as a FAILED tool event.
 */
export interface HookBlockedToolError {
  readonly error: {
    readonly code: 'tool_blocked_by_hook';
    readonly message: string;
    readonly toolName: string;
  };
  readonly ok: false;
  readonly reason?: string;
}

/** Cap on PostToolUse `additionalContext` merged into a tool result (chars). */
export const HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET = 2000;
