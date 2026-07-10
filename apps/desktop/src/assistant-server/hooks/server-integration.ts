/**
 * Desktop assistant-server ⇆ hooks composition helpers.
 *
 * Keeps `initializeAgentStream` thin: this module resolves per-request roots +
 * trust into a HookManager, derives the current user text for UserPromptSubmit,
 * prepends injected context, builds the short-circuit stream for a blocked
 * turn, and wraps the model stream with the terminal Stop hook.
 */

import type {
  AgentHookRunner,
  AgentMessage,
  AssistantRunEvent,
  HookTrustRequest,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/agent';
import { createAssistantRunEvent, resolveToolTimeoutMs } from '@brainstrike/agent';
import type { ScopedLogger } from '@brainstrike/utils';
import { getWorkspaceRoots } from '../workspace-roots';
import { getGlobalHooksPath, loadHooksConfig } from './config';
import { createDesktopHookRunner } from './hook-runner-impl';
import { HookManager, type HookRunEventInput } from './manager';

/** Convert a manager run-event input into a full (unstamped) AssistantRunEvent. */
export function hookRunEventToAssistant(input: HookRunEventInput): AssistantRunEvent {
  return {
    id: `run-event-${crypto.randomUUID()}`,
    kind: input.kind,
    label: input.label,
    status: input.status,
    timestamp: new Date().toISOString(),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export interface BuildHookManagerInput {
  readonly emitRunEvent?: (event: HookRunEventInput) => void;
  readonly hookTrustRequest: HookTrustRequest | undefined;
  readonly logger: ScopedLogger;
  readonly runtimeData: RuntimeData | undefined;
  readonly sessionId: string;
}

export function buildHookManager(input: BuildHookManagerInput): HookManager {
  const roots = getWorkspaceRoots(input.runtimeData).map((root) => ({
    absPath: root.path,
    rootId: root.rootId,
  }));
  const approvedByRoot = new Map<string, string>();
  for (const approval of input.hookTrustRequest?.approvals ?? []) {
    approvedByRoot.set(approval.rootId, approval.sha256);
  }
  const primaryCwd = roots[0]?.absPath ?? process.cwd();
  // One number governs both the pre-stream aggregate config check and the
  // runtime UserPromptSubmit wall-clock bound: the tool timeout (60s default),
  // which sits under the stream inactivity watchdog (120s).
  const aggregateTimeoutMs = resolveToolTimeoutMs();
  const load = loadHooksConfig({
    aggregateTimeoutMs,
    globalPath: getGlobalHooksPath(),
    maxHookTimeoutMs: resolveToolTimeoutMs(),
    primaryRootCwd: primaryCwd,
    roots: roots.map((root) => {
      const approvedSha256 = approvedByRoot.get(root.rootId);
      return {
        absPath: root.absPath,
        rootId: root.rootId,
        ...(approvedSha256 === undefined ? {} : { approvedSha256 }),
      };
    }),
  });
  return new HookManager(load, {
    logger: input.logger,
    primaryCwd,
    sessionId: input.sessionId,
    userPromptSubmitAggregateMs: aggregateTimeoutMs,
    ...(input.emitRunEvent ? { emitRunEvent: input.emitRunEvent } : {}),
  });
}

export interface RequestHooks {
  readonly manager: HookManager;
  /** Present iff there is at least one valid hook (used to gate injection). */
  readonly runner: AgentHookRunner | undefined;
}

export interface PrepareRequestHooksInput {
  readonly emitRunEvent?: (event: HookRunEventInput) => void;
  readonly hookTrustRequest: HookTrustRequest | undefined;
  readonly logger: ScopedLogger;
  readonly runId: string | undefined;
  readonly runtimeData: RuntimeData | undefined;
}

/**
 * Build the per-request hook manager, surface any config errors, and resolve
 * the TRUSTED server-side runner (present iff valid hooks exist). Keeps the
 * branching out of `initializeAgentStream`.
 */
export function prepareRequestHooks(input: PrepareRequestHooksInput): RequestHooks {
  const sessionId = input.runtimeData?.memory?.threadId ?? input.runId ?? 'no-session';
  const manager = buildHookManager({
    hookTrustRequest: input.hookTrustRequest,
    logger: input.logger,
    runtimeData: input.runtimeData,
    sessionId,
    ...(input.emitRunEvent ? { emitRunEvent: input.emitRunEvent } : {}),
  });
  manager.reportConfigErrors();
  const runner = manager.hasHooks() ? createDesktopHookRunner(manager) : undefined;
  return { manager, runner };
}

function extractUserText(message: AgentMessage): string {
  return message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

/** The current turn's user text (the LAST user message). Empty if none. */
export function deriveLastUserText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return extractUserText(message);
    }
  }
  return '';
}

/** Prepend a system context message carrying UserPromptSubmit hook output. */
export function prependHookContext(messages: AgentMessage[], text: string): AgentMessage[] {
  const contextMessage: AgentMessage = {
    id: `hook-context-${Date.now()}`,
    parts: [{ text, type: 'text' }],
    role: 'system',
  };
  return [contextMessage, ...messages];
}

export type UserPromptSubmitGateResult =
  | { readonly kind: 'block'; readonly reason: string }
  | { readonly kind: 'proceed'; readonly messages: AgentMessage[] };

/**
 * Run the UserPromptSubmit gate for a FRESH turn (never the approval/resume
 * path). Returns `block` (short-circuit the turn) or `proceed` with the
 * possibly context-prepended messages. A no-hook manager proceeds unchanged.
 */
export async function runUserPromptSubmitGate(
  manager: HookManager,
  messages: AgentMessage[],
  isResumeOrApproval: boolean
): Promise<UserPromptSubmitGateResult> {
  if (isResumeOrApproval || !manager.hasHooks()) {
    return { kind: 'proceed', messages };
  }
  const gate = await manager.runUserPromptSubmit(deriveLastUserText(messages));
  if (!gate.allowed) {
    return { kind: 'block', reason: gate.blockReason ?? 'Blocked by a hook.' };
  }
  if (gate.additionalContext) {
    return { kind: 'proceed', messages: prependHookContext(messages, gate.additionalContext) };
  }
  return { kind: 'proceed', messages };
}

/**
 * The short-circuit stream returned when a UserPromptSubmit hook rejects a turn:
 * a visible assistant message + a terminal `run.failed` run-event + an error
 * finish. The model is never invoked. Run-event runId/sequence are stamped by
 * the observer wrapper.
 */
export async function* makeHookBlockedStream(reason: string): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', value: `The request was blocked by a hook: ${reason}` };
  yield {
    event: createAssistantRunEvent({
      detail: reason,
      kind: 'run.failed',
      label: 'Assistant run blocked by hook',
      status: 'failed',
    }),
    type: 'run-event',
  };
  yield {
    finishReason: 'error',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  };
}

/**
 * Wrap the model stream with the terminal Stop hook. In v1 Stop is NOTIFY-ONLY:
 * the run-event surfacing (a block reason becomes a visible `hook.notice`) rides
 * the manager's emitRunEvent → queued-run-events → observer path; there is NO
 * auto-continue.
 *
 * The Stop hook MUST run BEFORE the terminal `message-finish` chunk is yielded:
 * the live data-stream consumer (`AssistantDataStreamSession`) stops pulling the
 * source the instant the mapper emits `finish`, so a `hook.notice`/`hook.blocked`
 * queued AFTER the finish is never drained by the observer — it reaches neither
 * the live renderer nor persistence. Running Stop at the finish boundary lets the
 * observer drain the queued events (at the top of the finish iteration) so they
 * are emitted as run-event chunks BEFORE the finish; the DataStreamMapper defers
 * them past any open text part and flushes them at the finish boundary. Stop
 * still fires best-effort in `finally` for the streams that end WITHOUT a finish
 * chunk (a bare generator return, a throw, or an abort).
 */
export async function* withStopHook(
  stream: AsyncIterable<StreamChunk>,
  manager: HookManager,
  signal: AbortSignal
): AsyncIterable<StreamChunk> {
  let sawError = false;
  let stopRan = false;
  const runStopOnce = async (): Promise<void> => {
    if (stopRan) {
      return;
    }
    stopRan = true;
    await manager.runStop(signal.aborted ? 'aborted' : sawError ? 'error' : 'complete');
  };
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'message-finish') {
        if (chunk.finishReason === 'error') {
          sawError = true;
        }
        await runStopOnce();
      }
      yield chunk;
    }
  } finally {
    await runStopOnce();
  }
}

/**
 * Apply the terminal Stop hook (only when hooks exist) and the caller's
 * run-event observer wrapper to a resolved model stream.
 */
export function finalizeHookedStream(
  stream: AsyncIterable<StreamChunk>,
  opts: {
    readonly manager: HookManager;
    readonly runner: AgentHookRunner | undefined;
    readonly signal: AbortSignal;
    readonly observe: (source: AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;
  }
): AsyncIterable<StreamChunk> {
  const gated = opts.runner ? withStopHook(stream, opts.manager, opts.signal) : stream;
  return opts.observe(gated);
}
