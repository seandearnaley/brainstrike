/**
 * Thread-scoped loop guards for repeated workspace inspection and edit
 * failures (BST-1188).
 *
 * Three independent in-memory mechanisms live here: consecutive identical
 * calls to selected read/search tools warn and then refuse; unchanged fresh
 * `readWorkspaceFile` windows return a compact stub and then refuse; repeated
 * ambiguous/not-found string replacements gain stronger recovery guidance.
 * Every map is scoped by `readStateScope(runtimeData)` at its production call
 * site so one thread never inherits another thread's streak.
 *
 * This mirrors `packages/agent/src/tools/file-read-state.ts`: state lasts only
 * for the desktop main-process lifetime, and the reset export exists ONLY for
 * test isolation. It is ephemeral execution state, not persisted application
 * state, and MUST NOT be wired into factory reset.
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

function getOrCreateScopeMap<T>(
  store: Map<string, Map<string, T>>,
  threadScope: string
): Map<string, T> {
  const existing = store.get(threadScope);
  if (existing) {
    return existing;
  }
  const created = new Map<string, T>();
  store.set(threadScope, created);
  return created;
}

export function checkRepeatedToolCall(
  threadScope: string,
  toolId: string,
  args: unknown
): { readonly count: number; readonly status: 'ok' | 'refuse' | 'warn' } {
  const callsByTool = getOrCreateScopeMap(repeatedToolCalls, threadScope);
  const argsKey = stableNormalizedArgsKey(args);
  const previous = callsByTool.get(toolId);
  const count = previous?.argsKey === argsKey ? previous.count + 1 : 1;
  callsByTool.set(toolId, { argsKey, count });
  return {
    count,
    status: count >= 4 ? 'refuse' : count >= 3 ? 'warn' : 'ok',
  };
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

export function mergeHintWithWarning(
  existingHint: string | undefined,
  warningText: string
): string {
  return existingHint ? `${warningText} ${existingHint}` : warningText;
}

/**
 * Mechanism 1 for a `hint`-bearing result (grepSearch/globWorkspace): refuse
 * without running `run` at all on the 4th+ consecutive identical call, else
 * run it and fold a warning into its `hint` on the 3rd. `run`'s result is
 * mutated in place (never spread into a new object) so callers that tag the
 * SAME object elsewhere (e.g. WeakMap-keyed telemetry) keep that tag.
 */
export async function withRepeatedCallGuard<TResult extends { hint?: string }>(args: {
  readonly input: unknown;
  readonly run: () => Promise<TResult>;
  readonly threadScope: string;
  readonly toolId: string;
}): Promise<LoopGuardRefusalResult | TResult> {
  const loopGuard = checkRepeatedToolCall(args.threadScope, args.toolId, args.input);
  if (loopGuard.status === 'refuse') {
    return buildRepeatedCallRefusalResult(args.toolId, loopGuard.count);
  }
  const result = await args.run();
  if (loopGuard.status === 'warn') {
    result.hint = mergeHintWithWarning(
      result.hint,
      buildRepeatedCallWarningText(args.toolId, loopGuard.count)
    );
  }
  return result;
}

export function readWindowKey(args: {
  readonly endLine: number | null | undefined;
  readonly path: string;
  readonly rootId: string;
  readonly startLine: number | null | undefined;
}): string {
  return stableNormalizedArgsKey({
    endLine: args.endLine ?? null,
    path: args.path,
    rootId: args.rootId,
    startLine: args.startLine ?? null,
  });
}

export function checkUnchangedReadWindow(
  threadScope: string,
  windowKey: string,
  mtimeMs: number
): { readonly count: number; readonly status: 'fresh' | 'refuse' | 'stub' } {
  const windowsByKey = getOrCreateScopeMap(unchangedReadWindows, threadScope);
  const previous = windowsByKey.get(windowKey);
  const count = previous?.mtimeMs === mtimeMs ? previous.count + 1 : 1;
  windowsByKey.set(windowKey, { count, mtimeMs });
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
  failuresByPath.set(key, count);
  return count;
}

export function resetEditFailureStreak(threadScope: string, rootId: string, path: string): void {
  editFailureStreaks.get(threadScope)?.delete(editFailurePathKey(rootId, path));
}

export function editFailureHintApplies(count: number): boolean {
  return count >= 3;
}

/** Clear ephemeral state for test isolation; never called by production reset. */
export function resetToolCallLoopGuards(threadScope?: string): void {
  if (threadScope === undefined) {
    repeatedToolCalls.clear();
    unchangedReadWindows.clear();
    editFailureStreaks.clear();
    return;
  }
  repeatedToolCalls.delete(threadScope);
  unchangedReadWindows.delete(threadScope);
  editFailureStreaks.delete(threadScope);
}
