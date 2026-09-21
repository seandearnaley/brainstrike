import { readToolCallId } from './read-tool-call-id';
import type { ToolLogger } from './types';

/**
 * The per-tool execution guard's cancellation seam (BST-1594).
 *
 * `guardToolExecution` resolves a `tool_timeout` when a tool overruns its
 * budget, which unblocks the model — but winning a race only stops the WAIT,
 * it never stops the work. An MCP `tools/call` abandoned that way keeps its
 * host request open: the SDK re-arms its 60s request timeout on every progress
 * notification (`resetTimeoutOnProgress`), so a progress-emitting server can
 * hold the request for the full 10 minute `maxTotalTimeout` and is never told
 * the caller left. The eventual `RequestTimeout` then surfaced as a whole
 * server generation failing over one slow call.
 *
 * The guard therefore publishes a deadline signal for the call it is guarding
 * and aborts it at the moment it gives up. A cancellable tool reads the signal
 * here and folds it into whatever signal it already honours; the MCP runtime
 * client does exactly that, so the SDK cancels the in-flight request
 * (`notifications/cancelled`) instead of leaving it dangling.
 *
 * KEYED BY TOOL-CALL ID, deliberately. Mastra RECONSTRUCTS the execution
 * context between the guarded `execute` and the tool's own callback (verified
 * against @mastra/core 1.55: the object identity differs, only its members are
 * carried over), so a context-identity WeakMap would silently read empty. The
 * tool-call id survives that reconstruction and already has exactly one reader
 * (`readToolCallId`), which is reused here so a future Mastra relocation
 * breaks in one place rather than three. Registration hands back an explicit
 * release the guard runs in its `finally`, so the map never outlives the call.
 *
 * A call with no tool-call id publishes nothing and `readToolGuardDeadlineSignal`
 * returns `undefined`: that is the pre-guard behaviour (the caller's own signal
 * and the SDK's request bounds still apply), never a fabricated deadline.
 *
 * The id is PROVIDER DATA, so two live executions can collide on it — a
 * provider that restarts its `call_1`/`call_2` sequence for a subagent run, or
 * a replayed call. The registry cannot tell the two apart, so the later
 * registration wins (it is the call the model is still waiting on) and the
 * earlier one then reads the wrong deadline until the later call releases.
 * That is REPORTED, never absorbed: see
 * {@link registerToolGuardDeadlineSignal}.
 */
const deadlineSignals = new Map<string, AbortSignal>();

/**
 * Publish the guard's deadline for one tool execution.
 *
 * A collision on `toolCallId` is LOGGED, not thrown. Throwing would be the
 * louder signal, but the id arrives as provider data rather than from a
 * programming error on our side, and this function runs on the only path into
 * `execute`: rejecting here would take a working tool call down over an id the
 * provider chose. Logging keeps the call working and makes the mis-routing a
 * diagnosable event instead of an invisible one — the failure it precedes (a
 * cancellation landing on the wrong request, or a deadline that never fires)
 * is otherwise unattributable.
 *
 * @param args the arguments Mastra passed to `execute` (input first, execution
 *   context second — the position {@link readToolCallId} documents).
 * @returns the release the guard must run once the call has settled.
 */
export function registerToolGuardDeadlineSignal(
  args: readonly unknown[],
  signal: AbortSignal,
  logger?: ToolLogger
): () => void {
  const toolCallId = readToolCallId(args);
  if (!toolCallId) {
    return () => undefined;
  }
  const existing = deadlineSignals.get(toolCallId);
  if (existing && existing !== signal) {
    logger?.error('Tool guard deadline id collision', {
      detail:
        'Two live guarded executions share one tool-call id; the earlier call reads the later deadline until the later call releases.',
      toolCallId,
    });
  }
  deadlineSignals.set(toolCallId, signal);
  return (): void => {
    if (deadlineSignals.get(toolCallId) === signal) {
      deadlineSignals.delete(toolCallId);
    }
  };
}

/** The guard deadline for the execution this context belongs to, if any. */
export function readToolGuardDeadlineSignal(executionContext: unknown): AbortSignal | undefined {
  const toolCallId = readToolCallId([undefined, executionContext]);
  return toolCallId === undefined ? undefined : deadlineSignals.get(toolCallId);
}

/**
 * The signal a cancellable tool must honour: its execution signal (user Stop,
 * run abort) folded with the guard's deadline for this call.
 *
 * Until BST-1777 only the MCP client read the deadline, so a native command
 * kept running after the model had been told it failed — and the model's retry
 * then raced the orphan. Every tool that owns a process or a request uses this
 * instead of reading `context.abortSignal` directly.
 *
 * The execution signal is returned BY IDENTITY when there is no deadline:
 * `retainRawMcpCallToolResult` keys on that identity.
 */
export function resolveGuardedToolSignal(executionContext: unknown): AbortSignal | undefined {
  const executionSignal =
    typeof executionContext === 'object' && executionContext !== null
      ? (executionContext as { abortSignal?: unknown }).abortSignal
      : undefined;
  const execution = executionSignal instanceof AbortSignal ? executionSignal : undefined;
  const guardDeadline = readToolGuardDeadlineSignal(executionContext);
  if (!guardDeadline) {
    return execution;
  }
  return execution ? AbortSignal.any([execution, guardDeadline]) : guardDeadline;
}
