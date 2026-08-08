/**
 * Thread-scoped loop guards for repeated workspace inspection and edit
 * failures (BST-1188).
 *
 * Two independent in-memory mechanisms live here: consecutive identical calls
 * to grepSearch/globWorkspace warn and then refuse; repeated ambiguous/
 * not-found string replacements gain stronger recovery guidance. A third,
 * mtime-aware mechanism for `readWorkspaceFile` (unchanged fresh reads return
 * a compact stub, then refuse) lives in `read-workspace-file-tool.ts` itself,
 * built on this module's `checkUnchangedReadWindow`/refusal primitives —
 * `readWorkspaceFile` deliberately does NOT use the plain identical-args
 * streak below (see the `withRepeatedCallGuard` docstring for why). Every map
 * is scoped by `readStateScope(runtimeData)` at its production call site so
 * one thread never inherits another thread's streak.
 *
 * This mirrors `packages/agent/src/tools/file-read-state.ts`: state lasts only
 * for the desktop main-process lifetime. It is still ephemeral execution
 * state, not persisted application state, and MUST NOT be wired into factory
 * reset. The reset export is no longer test-isolation-only (BST-1192): a
 * committed stale-read projection batch resets the affected production
 * thread too, so no dedup stub can point at evidence the batch just
 * collapsed. BST-1197 bounds each inner map at the exported
 * `MAX_KEYS_PER_THREAD_SCOPE` (256) with insertion-order LRU-on-write
 * eviction (delete, then set), and bounds the shared outer activity set at
 * the exported `MAX_TRACKED_THREAD_SCOPES` (256). Mechanisms 2
 * (`unchangedReadWindows`) and 3 (`editFailureStreaks`) intentionally dedup
 * across unrelated whole-thread activity, so their generous key cap preserves
 * useful multi-file history; mechanism 1 only has grep/glob entries in
 * practice, so the same cap is harmless headroom. Every write path promotes
 * its scope through `getOrCreateScopeMap`, while `peekRepeatedToolCall` also
 * promotes through `touchThreadScope` so a refuse-only loop cannot be evicted
 * as falsely idle before it reaches a commit. A key or scope is forgotten only
 * after the corresponding cap's worth of OTHER identities are touched in
 * between, when the activity is no longer meaningfully contiguous and
 * restarting fresh is correct.
 */

interface RepeatedToolCallState {
  readonly argsKey: string;
  readonly count: number;
}

interface UnchangedReadWindowState {
  readonly count: number;
  readonly mtimeMs: number;
}

export interface LoopGuardRefusalResult {
  readonly error: string;
  readonly ok: false;
  readonly refused: true;
}

const repeatedToolCalls = new Map<string, Map<string, RepeatedToolCallState>>();
const unchangedReadWindows = new Map<string, Map<string, UnchangedReadWindowState>>();
const editFailureStreaks = new Map<string, Map<string, number>>();
const threadScopeActivity = new Set<string>();

export const MAX_KEYS_PER_THREAD_SCOPE = 256;
export const MAX_TRACKED_THREAD_SCOPES = 256;

export const UNCHANGED_READ_STUB_MESSAGE =
  'File unchanged since last read — refer to the earlier readWorkspaceFile result in this conversation.';

export const EDIT_FAILURE_HINT_MESSAGE =
  'Repeated string replacement failures on this path. Re-read the file fresh, then retry with a wider oldStr that includes more surrounding context; use writeWorkspaceFile when the intended change requires a full rewrite.';

function normalizeJsonValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === undefined) {
    return;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (ancestors.has(value)) {
    throw new TypeError('Cannot normalize circular tool arguments.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .filter((item) => item !== undefined)
        .map((item) => normalizeJsonValue(item, ancestors));
    }
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = normalizeJsonValue(Reflect.get(value, key), ancestors);
      if (item !== undefined) {
        normalized[key] = item;
      }
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

/** Deterministic JSON key for parsed tool arguments. */
export function stableNormalizedArgsKey(value: unknown): string {
  const serialized = JSON.stringify(normalizeJsonValue(value, new WeakSet<object>()));
  if (serialized === undefined) {
    throw new TypeError('Tool arguments cannot be normalized as JSON.');
  }
  return serialized;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
}

function touchThreadScope(threadScope: string): void {
  threadScopeActivity.delete(threadScope);
  threadScopeActivity.add(threadScope);
  if (threadScopeActivity.size > MAX_TRACKED_THREAD_SCOPES) {
    const oldest = threadScopeActivity.values().next().value;
    if (oldest !== undefined) {
      threadScopeActivity.delete(oldest);
      repeatedToolCalls.delete(oldest);
      unchangedReadWindows.delete(oldest);
      editFailureStreaks.delete(oldest);
    }
  }
}

function getOrCreateScopeMap<T>(
  store: Map<string, Map<string, T>>,
  threadScope: string
): Map<string, T> {
  touchThreadScope(threadScope);
  const existing = store.get(threadScope);
  if (existing) {
    return existing;
  }
  const created = new Map<string, T>();
  store.set(threadScope, created);
  return created;
}

export interface RepeatedCallCheck {
  readonly count: number;
  readonly status: 'ok' | 'refuse' | 'warn';
}

/**
 * READ-ONLY with respect to the observable identical-args streak: reports
 * what the streak WOULD become if the call succeeds, but never mutates
 * `repeatedToolCalls`. Pair with `commitRepeatedToolCall` after the call
 * actually produces a result. A call that THROWS must never advance the
 * streak: "refused after N attempts with no new information, use the result
 * already in context" is false when every attempt errored and there is no
 * result in context (PR #2323 review).
 *
 * The peek does update the separate cross-mechanism thread-scope LRU. Refused
 * calls never reach `commitRepeatedToolCall`, so this bookkeeping touch keeps
 * a refuse-only loop from being evicted as falsely idle without advancing its
 * successful-call streak (PR #2332 review).
 */
export function peekRepeatedToolCall(
  threadScope: string,
  toolId: string,
  args: unknown
): RepeatedCallCheck {
  touchThreadScope(threadScope);
  const argsKey = stableNormalizedArgsKey(args);
  const previous = repeatedToolCalls.get(threadScope)?.get(toolId);
  const count = previous?.argsKey === argsKey ? previous.count + 1 : 1;
  return {
    count,
    status: count >= 4 ? 'refuse' : count >= 3 ? 'warn' : 'ok',
  };
}

/** Commit the streak `count` a matching `peekRepeatedToolCall` computed — call ONLY after the call succeeds. */
export function commitRepeatedToolCall(
  threadScope: string,
  toolId: string,
  args: unknown,
  count: number
): void {
  const callsByTool = getOrCreateScopeMap(repeatedToolCalls, threadScope);
  setBounded(
    callsByTool,
    toolId,
    { argsKey: stableNormalizedArgsKey(args), count },
    MAX_KEYS_PER_THREAD_SCOPE
  );
}

export function buildRepeatedCallWarningText(toolId: string, count: number): string {
  return `You have made this exact ${toolId} call ${count} times in a row; the results have not changed. Use the information already in context.`;
}

export function buildRepeatedCallRefusalResult(
  toolId: string,
  count: number
): LoopGuardRefusalResult {
  return {
    error: `Refused this exact ${toolId} call after ${count} consecutive attempts with no new information. Use the result already in context.`,
    ok: false,
    refused: true,
  };
}

export function isLoopGuardRefusal(value: unknown): value is LoopGuardRefusalResult {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['ok'] === false && record['refused'] === true && typeof record['error'] === 'string'
  );
}

/**
 * Mechanism 1 (grepSearch/globWorkspace ONLY — see module docstring for why
 * `readWorkspaceFile` is excluded): refuse without running `run` at all on
 * the 4th+ consecutive identical call, else run it and stamp a THIRD-call
 * warning as its own `loopGuardWarning` field. NOT folded into `hint`: the
 * purpose-built grep/glob projectors only render `hint` when the page was NOT
 * already trimmed by the output-char budget (`omittedByProjection`), so on
 * exactly the large/expensive repeats this guard exists to stop, a
 * `hint`-only warning would silently vanish (PR #2323 review). The projectors
 * render `loopGuardWarning` as its own line unconditionally, the same way
 * they already render `liveNote`/`probeNote`.
 *
 * The streak is committed ONLY after `run` resolves (never on a throw), and
 * `run`'s result is mutated in place (never spread into a new object) so
 * callers that tag the SAME object elsewhere (e.g. WeakMap-keyed telemetry)
 * keep that tag.
 */
export async function withRepeatedCallGuard<TResult extends { loopGuardWarning?: string }>(args: {
  readonly input: unknown;
  readonly run: () => Promise<TResult>;
  readonly threadScope: string;
  readonly toolId: string;
}): Promise<LoopGuardRefusalResult | TResult> {
  const peek = peekRepeatedToolCall(args.threadScope, args.toolId, args.input);
  if (peek.status === 'refuse') {
    return buildRepeatedCallRefusalResult(args.toolId, peek.count);
  }
  const result = await args.run();
  commitRepeatedToolCall(args.threadScope, args.toolId, args.input, peek.count);
  if (peek.status === 'warn') {
    result.loopGuardWarning = buildRepeatedCallWarningText(args.toolId, peek.count);
  }
  return result;
}

export function readWindowKey(args: {
  readonly endLine: number | null | undefined;
  readonly maxChars: number;
  readonly path: string;
  readonly rootId: string;
  readonly startLine: number | null | undefined;
}): string {
  return stableNormalizedArgsKey({
    endLine: args.endLine ?? null,
    maxChars: args.maxChars,
    path: args.path,
    rootId: args.rootId,
    startLine: args.startLine ?? null,
  });
}

/**
 * Mechanism 2 (`readWorkspaceFile` only): call ONLY after the caller has
 * already built a successful, NON-TRUNCATED page for this exact request —
 * never before or on a request that returned only part of the window (PR
 * #2323 review: recording an observation for a call that later fails to
 * produce a page falsely primes the NEXT retry to look like a repeat, and
 * stubbing away a truncated page would silently discard the reader's only
 * `nextCursor` to the rest of the file). Always mutates — this is the commit,
 * there is no separate peek, because by the time it is called the read has
 * already succeeded.
 */
export function checkUnchangedReadWindow(
  threadScope: string,
  windowKey: string,
  mtimeMs: number
): { readonly count: number; readonly status: 'fresh' | 'refuse' | 'stub' } {
  const windowsByKey = getOrCreateScopeMap(unchangedReadWindows, threadScope);
  const previous = windowsByKey.get(windowKey);
  const count = previous?.mtimeMs === mtimeMs ? previous.count + 1 : 1;
  setBounded(windowsByKey, windowKey, { count, mtimeMs }, MAX_KEYS_PER_THREAD_SCOPE);
  return {
    count,
    status: count >= 3 ? 'refuse' : count === 2 ? 'stub' : 'fresh',
  };
}

function editFailurePathKey(rootId: string, path: string): string {
  return stableNormalizedArgsKey({ path, rootId });
}

export function recordEditFailure(threadScope: string, rootId: string, path: string): number {
  const failuresByPath = getOrCreateScopeMap(editFailureStreaks, threadScope);
  const key = editFailurePathKey(rootId, path);
  const count = (failuresByPath.get(key) ?? 0) + 1;
  setBounded(failuresByPath, key, count, MAX_KEYS_PER_THREAD_SCOPE);
  return count;
}

export function resetEditFailureStreak(threadScope: string, rootId: string, path: string): void {
  editFailureStreaks.get(threadScope)?.delete(editFailurePathKey(rootId, path));
}

export function editFailureHintApplies(count: number): boolean {
  return count >= 3;
}

/**
 * Clear ephemeral state for test isolation or after a production projection
 * rewrite commit. This is never part of factory reset; that reset destroys the
 * process-local maps with the process/profile lifecycle already.
 */
export function resetToolCallLoopGuards(threadScope?: string): void {
  if (threadScope === undefined) {
    repeatedToolCalls.clear();
    unchangedReadWindows.clear();
    editFailureStreaks.clear();
    threadScopeActivity.clear();
    return;
  }
  repeatedToolCalls.delete(threadScope);
  unchangedReadWindows.delete(threadScope);
  editFailureStreaks.delete(threadScope);
  threadScopeActivity.delete(threadScope);
}
