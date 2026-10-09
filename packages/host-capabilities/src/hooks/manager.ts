/**
 * HookManager — orchestrates config + trust + executor for one request.
 *
 * Per-event methods build the correct `HookStdin`, filter tool events by the
 * precompiled matcher, run the hooks via the executor, and surface outcomes as
 * `hook.blocked` / `hook.notice` run events. Config errors (D2) are surfaced
 * once as `hook.notice(failed)`. SessionStart/SessionEnd/Notification are
 * implemented but UNWIRED in v1 (§9).
 */

import type { AssistantRunEventMetadata, AssistantRunEventStatus } from '@brainstrike/agent';
import type { ScopedLogger } from '@brainstrike/logging';
import { runHooksForEvent } from './executor.js';
import {
  type HookEventName,
  type HookEventResult,
  type HooksConfigLoadResult,
  isBlockingEvent,
  type LoadedHook,
} from './types.js';

type HookLogger = Pick<ScopedLogger, 'debug' | 'info' | 'warn' | 'error'>;

export interface HookRunEventInput {
  readonly detail?: string;
  readonly kind: 'hook.blocked' | 'hook.notice';
  readonly label: string;
  readonly metadata?: AssistantRunEventMetadata;
  readonly status: AssistantRunEventStatus;
}

export interface HookManagerContext {
  /**
   * Wall-clock ceiling for a whole bounded hook phase, applied to BOTH the
   * PRE-STREAM `UserPromptSubmit` gate (runs before the model is invoked, so the
   * stream inactivity watchdog cannot bound it) AND the terminal `Stop` phase
   * (runs at the finish boundary in FRONT of the `message-finish` chunk, so an
   * unbounded chain of Stop hooks would delay finish delivery — the watchdog is
   * upstream of the Stop seam and its timer is disarmed while Stop awaits).
   * The other in-stream phases (PreToolUse/PostToolUse) stay uncapped here.
   */
  readonly aggregateTimeoutMs: number;
  readonly emitRunEvent?: (event: HookRunEventInput) => void;
  readonly logger: HookLogger;
  /** cwd for non-tool events (UserPromptSubmit/Stop/Session). */
  readonly primaryCwd: string;
  /** = memory.threadId ?? runId ?? 'no-session'. */
  readonly sessionId: string;
}

function matchesTool(hook: LoadedHook, toolName: string): boolean {
  return hook.toolNameRegex === undefined || hook.toolNameRegex.test(toolName);
}

export class HookManager {
  private readonly load: HooksConfigLoadResult;
  private readonly ctx: HookManagerContext;
  private reportedConfigErrors = false;

  constructor(load: HooksConfigLoadResult, ctx: HookManagerContext) {
    this.load = load;
    this.ctx = ctx;
  }

  hasHooks(): boolean {
    return Object.values(this.load.hooks).some((list) => (list?.length ?? 0) > 0);
  }

  private hooksFor(event: HookEventName): readonly LoadedHook[] {
    return this.load.hooks[event] ?? [];
  }

  /** Emit one `hook.notice(failed)` per config error, at most once per manager. */
  reportConfigErrors(): void {
    if (this.reportedConfigErrors) {
      return;
    }
    this.reportedConfigErrors = true;
    for (const error of this.load.errors) {
      this.ctx.logger.error('hooks config error', {
        message: error.message,
        path: error.path,
        scope: error.scope,
      });
      const remedy =
        error.reason === 'untrusted' || error.reason === 'changed'
          ? ' — review it in Settings > Hooks'
          : '';
      this.ctx.emitRunEvent?.({
        detail: `${error.path}: ${error.message}${remedy}`,
        kind: 'hook.notice',
        label: 'Hook config disabled',
        status: 'failed',
      });
    }
  }

  private surfaceOutcome(event: HookEventName, result: HookEventResult): void {
    if (!result.allowed) {
      this.ctx.emitRunEvent?.({
        kind: 'hook.blocked',
        label: `Blocked by ${event} hook`,
        status: 'failed',
        ...(result.blockReason ? { detail: result.blockReason } : {}),
      });
      return;
    }
    if (result.additionalContext) {
      this.ctx.emitRunEvent?.({
        detail: result.additionalContext,
        kind: 'hook.notice',
        label: `${event} hook added context`,
        status: 'info',
      });
    }
    for (const warning of result.warnings) {
      this.ctx.emitRunEvent?.({
        detail: warning,
        kind: 'hook.notice',
        label: `${event} hook warning`,
        status: 'info',
      });
    }
  }

  /** Whether any PreToolUse hook would run for this tool. */
  matchesPreToolUse(toolName: string): boolean {
    return this.hooksFor('PreToolUse').some((hook) => matchesTool(hook, toolName));
  }

  async runPreToolUse(toolName: string, toolInput: unknown): Promise<HookEventResult> {
    const hooks = this.hooksFor('PreToolUse').filter((hook) => matchesTool(hook, toolName));
    const result = await runHooksForEvent(
      hooks,
      (hook) => ({
        cwd: hook.source.cwd,
        hook_event_name: 'PreToolUse',
        session_id: this.ctx.sessionId,
        tool_input: toolInput,
        tool_name: toolName,
      }),
      { blocking: true, logger: this.ctx.logger }
    );
    this.surfaceOutcome('PreToolUse', result);
    return result;
  }

  async runPostToolUse(input: {
    toolName: string;
    toolInput: unknown;
    toolOutput: unknown;
    toolError: boolean;
  }): Promise<HookEventResult> {
    const hooks = this.hooksFor('PostToolUse').filter((hook) => matchesTool(hook, input.toolName));
    const result = await runHooksForEvent(
      hooks,
      (hook) => ({
        cwd: hook.source.cwd,
        hook_event_name: 'PostToolUse',
        session_id: this.ctx.sessionId,
        tool_error: input.toolError,
        tool_input: input.toolInput,
        tool_name: input.toolName,
        tool_output: input.toolOutput,
      }),
      { blocking: false, logger: this.ctx.logger }
    );
    this.surfaceOutcome('PostToolUse', result);
    return result;
  }

  async runUserPromptSubmit(userMessage: string): Promise<HookEventResult> {
    const result = await runHooksForEvent(
      this.hooksFor('UserPromptSubmit'),
      () => ({
        cwd: this.ctx.primaryCwd,
        hook_event_name: 'UserPromptSubmit',
        session_id: this.ctx.sessionId,
        user_message: userMessage,
      }),
      {
        aggregateTimeoutMs: this.ctx.aggregateTimeoutMs,
        blocking: true,
        logger: this.ctx.logger,
      }
    );
    this.surfaceOutcome('UserPromptSubmit', result);
    return result;
  }

  async runStop(
    stopReason: 'complete' | 'aborted' | 'error',
    assistantMessage?: string
  ): Promise<HookEventResult> {
    const result = await runHooksForEvent(
      this.hooksFor('Stop'),
      () => ({
        cwd: this.ctx.primaryCwd,
        hook_event_name: 'Stop',
        session_id: this.ctx.sessionId,
        stop_reason: stopReason,
        ...(assistantMessage === undefined ? {} : { assistant_message: assistantMessage }),
      }),
      {
        aggregateTimeoutMs: this.ctx.aggregateTimeoutMs,
        blocking: true,
        // Stop is the run-scoped completion phase, so ONLY here may a hook
        // report a Task Ledger verdict for the run (strict stdout scan; see
        // run-verdict.ts). Malformed verdict lines surface as warnings →
        // hook.notice run events via surfaceOutcome below.
        captureRunVerdict: true,
        logger: this.ctx.logger,
      }
    );
    this.surfaceOutcome('Stop', result);
    return result;
  }

  /** UNWIRED in v1 (§9). Implemented for parity + future wiring. */
  private runSession(event: 'SessionStart' | 'SessionEnd'): Promise<HookEventResult> {
    return runHooksForEvent(
      this.hooksFor(event),
      () => ({
        cwd: this.ctx.primaryCwd,
        hook_event_name: event,
        session_id: this.ctx.sessionId,
      }),
      { blocking: isBlockingEvent(event), logger: this.ctx.logger }
    );
  }

  runSessionStart(): Promise<HookEventResult> {
    return this.runSession('SessionStart');
  }

  runSessionEnd(): Promise<HookEventResult> {
    return this.runSession('SessionEnd');
  }

  /** UNWIRED in v1 (§9). Fire-and-forget non-blocking notification hooks. */
  runNotification(reason: string, message?: string): Promise<HookEventResult> {
    return runHooksForEvent(
      this.hooksFor('Notification'),
      () => ({
        cwd: this.ctx.primaryCwd,
        hook_event_name: 'Notification',
        reason,
        session_id: this.ctx.sessionId,
        ...(message === undefined ? {} : { message }),
      }),
      { blocking: false, logger: this.ctx.logger }
    );
  }
}
