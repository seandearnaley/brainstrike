/**
 * Tool-lifecycle hooks — strict type definitions (desktop / main-process only).
 *
 * A hook is a user-authored shell command that runs at a lifecycle event and,
 * for blocking events, can refuse to proceed. Ported from the mastra-code-ui
 * reference and hardened to brainstrike's invariants (no `any`, discriminated
 * unions, provenance-tagged loaded hooks for multi-root + trust).
 */

import type { HookRunVerdict } from './run-verdict';

export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification';

export type BlockingHookEvent = 'PreToolUse' | 'Stop' | 'UserPromptSubmit';

export function isBlockingEvent(event: HookEventName): event is BlockingHookEvent {
  return event === 'PreToolUse' || event === 'Stop' || event === 'UserPromptSubmit';
}

export interface HookMatcher {
  /** Regex source matched against tool_name (PreToolUse/PostToolUse only). */
  readonly tool_name?: string;
}

export interface HookDefinition {
  /** Shell command executed via `/bin/sh -c` (Windows: `cmd /c`). */
  readonly command: string;
  readonly description?: string;
  readonly matcher?: HookMatcher;
  /** Timeout in ms. Positive integer `< maxHookTimeoutMs`. Default 10_000. */
  readonly timeout?: number;
  readonly type: 'command';
}

/** Provenance of a loaded hook — drives per-hook `cwd`, trust, and diagnostics. */
export interface HookSource {
  readonly cwd: string;
  readonly rootId?: string;
  readonly scope: 'global' | 'project';
}

/** A validated, loaded hook tagged with provenance + precompiled matcher. */
export interface LoadedHook {
  readonly definition: HookDefinition;
  readonly source: HookSource;
  /** Precompiled matcher (validated at load). undefined = matches all tools. */
  readonly toolNameRegex?: RegExp;
}

export type LoadedHooksByEvent = Partial<Record<HookEventName, readonly LoadedHook[]>>;

export interface HookConfigError {
  readonly message: string;
  readonly path: string;
  readonly rootId?: string;
  readonly scope: 'global' | 'project';
}

export interface HookConfigSource {
  readonly exists: boolean;
  readonly path: string;
  readonly rootId?: string;
  readonly scope: 'global' | 'project';
}

export interface HooksConfigLoadResult {
  /** One entry per disabled/failed/untrusted file (D2 fail-loud). */
  readonly errors: readonly HookConfigError[];
  /** Only the VALID files' hooks, in load order (global first, then roots). */
  readonly hooks: LoadedHooksByEvent;
  /** Every path considered, for the settings review UI. */
  readonly sources: readonly HookConfigSource[];
}

// =============================================================================
// Stdin protocol (JSON written to the hook process on stdin)
// =============================================================================

export interface HookStdinBase {
  readonly cwd: string;
  readonly hook_event_name: HookEventName;
  readonly session_id: string;
}

export interface HookStdinToolEvent extends HookStdinBase {
  readonly hook_event_name: 'PreToolUse' | 'PostToolUse';
  readonly tool_error?: boolean;
  readonly tool_input: unknown;
  readonly tool_name: string;
  readonly tool_output?: unknown;
}

export interface HookStdinUserPrompt extends HookStdinBase {
  readonly hook_event_name: 'UserPromptSubmit';
  readonly user_message: string;
}

export interface HookStdinStop extends HookStdinBase {
  readonly assistant_message?: string;
  readonly hook_event_name: 'Stop';
  readonly stop_reason: 'complete' | 'aborted' | 'error';
}

export interface HookStdinSession extends HookStdinBase {
  readonly hook_event_name: 'SessionStart' | 'SessionEnd';
}

export interface HookStdinNotification extends HookStdinBase {
  readonly hook_event_name: 'Notification';
  readonly message?: string;
  readonly reason: string;
}

export type HookStdin =
  | HookStdinToolEvent
  | HookStdinUserPrompt
  | HookStdinStop
  | HookStdinSession
  | HookStdinNotification;

// =============================================================================
// Stdout protocol (JSON read from the hook process)
// =============================================================================

export interface HookStdout {
  readonly additionalContext?: string;
  readonly decision?: 'allow' | 'block';
  readonly reason?: string;
}

// =============================================================================
// Execution results
// =============================================================================

export interface HookResult {
  readonly durationMs: number;
  readonly exitCode: number;
  readonly hook: HookDefinition;
  /**
   * Hook-reported run verdict (Task Ledger source 'hook'), strictly parsed
   * from raw stdout. Only populated when the phase opted in via
   * `RunHooksOptions.captureRunVerdict` (the run-scoped Stop phase).
   */
  readonly runVerdict?: HookRunVerdict;
  /** Content-free warnings for malformed verdict lines (visible, never a throw). */
  readonly runVerdictWarnings?: readonly string[];
  readonly stderr?: string;
  readonly stdout?: HookStdout;
  readonly timedOut: boolean;
}

export interface HookEventResult {
  readonly additionalContext?: string;
  readonly allowed: boolean;
  readonly blockReason?: string;
  readonly results: readonly HookResult[];
  /**
   * The phase's effective run verdict: the LAST hook (in execution order) with
   * a valid verdict line wins, mirroring the ledger's later-write-upserts rule.
   * Present even on a blocked phase — the verdict is an independent report.
   */
  readonly runVerdict?: HookRunVerdict;
  readonly warnings: readonly string[];
}

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
