import { readToolCallId } from './read-tool-call-id';

/**
 * A guard deadline belongs to one forwarded execution context, not its provider
 * call ID. Different runs, replays and concurrent invocations may share IDs.
 * The guard creates a fresh context per invocation, aborts the physical operation
 * before answering a timeout, and releases this entry in finally. The caller's
 * abortSignal stays untouched because raw MCP result retention uses its identity.
 */
const deadlineSignals = new WeakMap<object, AbortSignal>();

/** Publish one invocation's deadline; calls without host identity publish nothing. */
export function registerToolGuardDeadlineSignal(
  args: readonly unknown[],
  signal: AbortSignal
): () => void {
  const context = args[1];
  if (typeof context !== 'object' || context === null || !readToolCallId(args)) {
    return () => undefined;
  }
  const existing = deadlineSignals.get(context);
  if (existing && existing !== signal) {
    throw new Error('Tool execution context already owns a guard deadline');
  }
  deadlineSignals.set(context, signal);
  return (): void => {
    if (deadlineSignals.get(context) === signal) {
      deadlineSignals.delete(context);
    }
  };
}

/** The guard deadline for this exact invocation, never a lookup by provider ID. */
export function readToolGuardDeadlineSignal(executionContext: unknown): AbortSignal | undefined {
  return typeof executionContext === 'object' && executionContext !== null
    ? deadlineSignals.get(executionContext)
    : undefined;
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
  // A PRESENT but non-`AbortSignal` `abortSignal` fails LOUD (PR review). The
  // old `mergeCallToolSignals` path had no narrowing, so silently dropping a
  // duck-typed or cross-realm signal here would be a new silent degradation —
  // the tool would quietly stop honouring user Stop. Absent is fine; wrong is
  // not. `null` reads as absent too (round 2, Claude C): both prior code
  // paths (`mergeCallToolSignals`'s forward, `run-python-tool.ts`'s `??`
  // fallback) tolerated a `null` `abortSignal`, so only a present non-`null`,
  // non-`AbortSignal` value is the "wrong" this guards against.
  if (
    executionSignal !== undefined &&
    executionSignal !== null &&
    !(executionSignal instanceof AbortSignal)
  ) {
    throw new TypeError(
      `Execution context carries a non-AbortSignal abortSignal (${typeof executionSignal}); the guarded tool cannot honour cancellation.`
    );
  }
  const execution = executionSignal ?? undefined;
  const guardDeadline = readToolGuardDeadlineSignal(executionContext);
  if (!guardDeadline) {
    return execution;
  }
  return execution ? AbortSignal.any([execution, guardDeadline]) : guardDeadline;
}
