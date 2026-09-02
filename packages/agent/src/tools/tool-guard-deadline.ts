import { readToolCallId } from './read-tool-call-id';

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
 */
const deadlineSignals = new Map<string, AbortSignal>();

/**
 * Publish the guard's deadline for one tool execution.
 *
 * @param args the arguments Mastra passed to `execute` (input first, execution
 *   context second — the position {@link readToolCallId} documents).
 * @returns the release the guard must run once the call has settled.
 */
export function registerToolGuardDeadlineSignal(
  args: readonly unknown[],
  signal: AbortSignal
): () => void {
  const toolCallId = readToolCallId(args);
  if (!toolCallId) {
    return () => undefined;
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
