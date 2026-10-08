import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  GrepSearchInputSchema,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RuntimeData,
  type ToolProjectionRewriteEntry,
} from '@brainstrike/agent';
import { isNativeToolId, NATIVE_TOOL_ID, type NativeToolId } from '@brainstrike/assistant-contract';
import {
  decodedWorkspaceTextModelOutputChars,
  escapeProjectionPathLineBreaks,
  type GrepToolResult,
  grepProjectionHeaderPrefix,
  parseGrepToolResult,
  projectGrepSearchModelOutput,
  projectReadWorkspaceFileModelOutput,
  readProjectionHeaderPrefix,
  readStateScope,
  readToolCallId,
  redactToolErrorForLog,
  resetToolCallLoopGuards,
  resolveReadWorkspaceFileRootLabel,
  resolveToolExecuteInputCandidate,
  type ToolExecuteRunContext,
} from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import { getDatabase } from '../db-main';
import {
  decodedPersistedModelOutputChars,
  type RecencyPruneInvocation,
  selectRecencyPruneCandidates,
} from './tool-projection-prune';
import {
  commitProjectionRewriteCandidates,
  listPriorInvocations,
  type PersistedToolInvocation,
  type ProjectionRewriteDatabaseProvider,
} from './tool-projection-rewrite-store';

const logger = createLogger('ToolProjectionRewriteRepository');

/** Cline's 64 KiB stale-read compaction trigger, measured in projected chars. */
export const TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS = 65_536;

export { createToolProjectionRewriteLookup } from './tool-projection-rewrite-store';

interface ReadProjectionResult {
  readonly ambiguousRootNames?: string[];
  readonly endLine: number;
  readonly openRoots?: number;
  readonly path: string;
  readonly rootId?: string;
  readonly rootName: string;
  readonly startLine: number;
  readonly totalLines: number;
}

interface PreparedToolInvocation {
  readonly grepKey: string | undefined;
  readonly invocation: PersistedToolInvocation;
  readonly read: ReadProjectionResult | undefined;
  readonly readIsDedup: boolean;
}

type RewriteCandidate = ToolProjectionRewriteEntry & {
  readonly originalChars: number;
  readonly reclaimableChars: number;
};

/**
 * Supersession-only candidate shape: `readCandidate`/`grepCandidate`/
 * `collectCandidates` implement ONLY Layer 1 (BST-1192) detection, which
 * always produces a `kind: 'supersession'` row with a real superseder. Typing
 * their return as the full `RewriteCandidate` union (which also admits the
 * Layer 2 `kind: 'prune'` member) would let a later edit silently widen
 * `supersededByToolCallId` past the `null`-only prune shape without a type
 * error — see the discriminated union in `packages/agent/src/types.ts`.
 */
type SupersessionRewriteCandidate = Extract<RewriteCandidate, { kind: 'supersession' }>;

export interface SuccessfulToolProjection {
  readonly input: unknown;
  readonly result: unknown;
  readonly runtimeData: RuntimeData | undefined;
  readonly toolCallId: string | undefined;
  readonly toolId: NativeToolId;
}

export interface ToolProjectionRewriteDependencies {
  readonly getDatabase?: ProjectionRewriteDatabaseProvider;
  readonly resetLoopGuards?: (threadScope: string) => void;
}

interface RecencyPruneScanDependencies extends ToolProjectionRewriteDependencies {
  readonly excludeToolCallIds?: ReadonlySet<string>;
  readonly priorScan?: Awaited<ReturnType<typeof listPriorInvocations>>;
}

export interface RunRecencyPruneScanInput {
  readonly runtimeData: RuntimeData | undefined;
  readonly threadId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * BST-1248: toolCallIds that have already emitted a malformed-record warning.
 * Supersession detection re-scans the full thread history on EVERY subsequent
 * tool call, so without this memo a single malformed persisted record
 * re-warned once per later call — one record produced 139 duplicate
 * `tool_projection_rewrite_malformed_read_history` warnings in the 2026-08
 * audit.
 *
 * The memo dedupes WARNS ONLY — it must never gate parsing or key
 * normalization. A record can fail one consumer (`readCandidate`'s stricter
 * projection contract) while remaining perfectly valid for detection
 * (`readWasSuperseded` needs `later.read`, `grepWasSuperseded` needs both
 * sides' `grepKey`), so skipping the parse for a memoized record would
 * silently stop it acting as the superseder of OTHER, valid records for the
 * life of the process — a context-reclamation regression, not log hygiene.
 * The re-parse is cheap next to the `listPriorInvocations` DB scan.
 *
 * The set is not evicted: eviction interacts with the oldest→newest history
 * walk to degrade back into warn-every-scan past the cap. Instead, once the
 * cap of DISTINCT warned records is reached, ONE summary warning announces
 * that further first-encounter warnings are suppressed — an explicit ceiling,
 * not a cliff. Entries are ~30-byte ids, so the cap bounds memory at a few KB.
 */
const MALFORMED_WARN_MEMO_CAP = 512;
const warnedMalformedToolCallIds = new Set<string>();
let malformedWarnSuppressionAnnounced = false;
let malformedWarnMemoCap = MALFORMED_WARN_MEMO_CAP;

/**
 * True when this toolCallId's malformed-record warning should be emitted:
 * first encounter, below the distinct-record ceiling. Past the ceiling, one
 * summary warning is emitted and further first encounters stay silent.
 */
function shouldWarnMalformed(toolCallId: string): boolean {
  if (warnedMalformedToolCallIds.has(toolCallId)) {
    return false;
  }
  if (warnedMalformedToolCallIds.size >= malformedWarnMemoCap) {
    if (!malformedWarnSuppressionAnnounced) {
      malformedWarnSuppressionAnnounced = true;
      logger.warn('Further malformed persisted tool record warnings are suppressed', {
        code: 'tool_projection_rewrite_malformed_history_suppressed',
        distinctRecordCap: malformedWarnMemoCap,
      });
    }
    return false;
  }
  warnedMalformedToolCallIds.add(toolCallId);
  return true;
}

/** Test-only: reset the malformed-record warn memo between cases. */
export function resetMalformedProjectionMemoForTests(): void {
  warnedMalformedToolCallIds.clear();
  malformedWarnSuppressionAnnounced = false;
  malformedWarnMemoCap = MALFORMED_WARN_MEMO_CAP;
}

/** Test-only: lower the distinct-record warn ceiling (pass nothing to restore). */
export function setMalformedWarnMemoCapForTests(value?: number): void {
  malformedWarnMemoCap = value ?? MALFORMED_WARN_MEMO_CAP;
}

function parseReadProjectionResult(value: unknown): ReadProjectionResult | undefined {
  if (!isRecord(value)) {
    return;
  }
  const { ambiguousRootNames, endLine, openRoots, path, rootId, rootName, startLine, totalLines } =
    value;
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    typeof rootName !== 'string' ||
    rootName.length === 0 ||
    (rootId !== undefined && (typeof rootId !== 'string' || rootId.length === 0)) ||
    (openRoots !== undefined &&
      !(typeof openRoots === 'number' && Number.isInteger(openRoots) && openRoots > 0)) ||
    (ambiguousRootNames !== undefined &&
      !(
        Array.isArray(ambiguousRootNames) &&
        ambiguousRootNames.every((name) => typeof name === 'string')
      )) ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    !Number.isInteger(totalLines)
  ) {
    return;
  }
  return {
    ...(ambiguousRootNames ? { ambiguousRootNames } : {}),
    endLine: endLine as number,
    ...(openRoots === undefined ? {} : { openRoots: openRoots as number }),
    path,
    ...(rootId === undefined ? {} : { rootId }),
    rootName,
    startLine: startLine as number,
    totalLines: totalLines as number,
  };
}

export function buildReadSupersededMarker(
  result: ReadProjectionResult,
  supersederToolName: string
): string {
  // Mirrors read-workspace-file-model-projection.ts's own `read ` header
  // convention (PR #2322, merged) so a collapsed marker still reads as a
  // natural continuation of that format; the path is escaped the same way
  // that live projector escapes it so an embedded newline in a filename can
  // never break the marker's single-line invariant.
  const escapedPath = escapeProjectionPathLineBreaks(result.path);
  const rootLabel = resolveReadWorkspaceFileRootLabel(result);
  const displayPath = rootLabel ? `${rootLabel}:${escapedPath}` : escapedPath;
  const reason =
    supersederToolName === NATIVE_TOOL_ID.readWorkspaceFile
      ? 'see the later read of this file'
      : 'file was modified after this read — re-read before relying on it';
  return `${readProjectionHeaderPrefix()}${displayPath} lines ${result.startLine}-${result.endLine}/${result.totalLines} [superseded — ${reason}]`;
}

export function buildGrepSupersededMarker(outputMode: GrepToolResult['outputMode']): string {
  return `${grepProjectionHeaderPrefix(outputMode)}[superseded — results for this pattern were refreshed later]`;
}

/**
 * BST-1249: measure a persisted invocation's model-facing size from the
 * projection it actually shipped (`providerMetadata.mastra.modelOutput`),
 * exactly like recency pruning does. Re-projecting the raw result re-applies
 * the DEFAULT domain budget — smaller than the loop-guard/scaled budget some
 * runtimes used — so legitimately-large historical reads threw RangeError and
 * were mislabeled `tool_projection_rewrite_malformed_read_history` on every
 * scan. Only legacy rows persisted before modelOutput existed re-project, and
 * they do so under the CEILING budget (the largest any runtime could have
 * used), so no honestly-projected row can be branded malformed.
 */
function measurePersistedProjectionChars(
  invocation: PersistedToolInvocation,
  reprojectLegacy: () => string
): number {
  if (invocation.modelOutput !== undefined) {
    try {
      return decodedPersistedModelOutputChars(invocation.modelOutput);
    } catch (error) {
      // A present-but-unreadable persisted projection (e.g. an explicitly
      // persisted null — the store maps only a MISSING key to undefined) has
      // a perfectly good raw result; branding it malformed would re-create
      // the exact false label BST-1249 removes (review finding). Fall back to
      // the ceiling-budget re-projection, visibly.
      logger.debug('Unreadable persisted model output; re-projecting under the ceiling budget', {
        error: redactToolErrorForLog(error),
        toolCallId: invocation.toolCallId,
      });
    }
  }
  return decodedWorkspaceTextModelOutputChars([reprojectLegacy()]);
}

function readCandidate(
  invocation: PersistedToolInvocation,
  result: ReadProjectionResult,
  superseder: PersistedToolInvocation
): SupersessionRewriteCandidate | undefined {
  try {
    const markerText = buildReadSupersededMarker(result, superseder.toolName);
    // BST-1195: the ONE domain-projection ruler for `type: 'text'` outputs is
    // decoded code-point length (+ the fixed envelope reserve), never
    // JSON.stringify(...).length -- see workspace-model-projection-helpers.ts.
    // Both projectReadWorkspaceFileModelOutput and projectGrepSearchModelOutput
    // below return that shape.
    const originalChars = measurePersistedProjectionChars(
      invocation,
      () =>
        projectReadWorkspaceFileModelOutput(
          invocation.result,
          CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
        ).value
    );
    const markerChars = decodedWorkspaceTextModelOutputChars([markerText]);
    return {
      kind: 'supersession',
      markerText,
      originalChars,
      reclaimableChars: Math.max(0, originalChars - markerChars),
      supersededByToolCallId: superseder.toolCallId,
      toolCallId: invocation.toolCallId,
    };
  } catch (error) {
    if (shouldWarnMalformed(invocation.toolCallId)) {
      logger.warn('Skipping malformed persisted read result during supersession detection', {
        code: 'tool_projection_rewrite_malformed_read_history',
        error: redactToolErrorForLog(error),
        toolCallId: invocation.toolCallId,
      });
    }
    return;
  }
}

function grepCandidate(
  invocation: PersistedToolInvocation
): SupersessionRewriteCandidate | undefined {
  // The try covers ONLY the parse (review finding): a measurement failure is
  // not a malformed grep RESULT, and branding it
  // tool_projection_rewrite_malformed_grep_history would point a future audit
  // at the wrong cause. Measurement throws propagate to the outer post-success
  // bookkeeping catch, exactly as before BST-1249.
  let result: GrepToolResult;
  try {
    result = parseGrepToolResult(invocation.result);
  } catch (error) {
    if (shouldWarnMalformed(invocation.toolCallId)) {
      logger.warn('Skipping malformed persisted grep result during supersession detection', {
        code: 'tool_projection_rewrite_malformed_grep_history',
        error,
        toolCallId: invocation.toolCallId,
      });
    }
    return;
  }
  const markerText = buildGrepSupersededMarker(result.outputMode);
  const originalChars = measurePersistedProjectionChars(
    invocation,
    () =>
      projectGrepSearchModelOutput(
        invocation.result,
        CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
      ).value
  );
  const markerChars = decodedWorkspaceTextModelOutputChars([markerText]);
  return {
    kind: 'supersession',
    markerText,
    originalChars,
    reclaimableChars: Math.max(0, originalChars - markerChars),
    supersededByToolCallId: '',
    toolCallId: invocation.toolCallId,
  };
}

function normalizeGrepKey(
  invocation: PersistedToolInvocation,
  persisted: boolean
): string | undefined {
  const candidate = resolveToolExecuteInputCandidate(GrepSearchInputSchema, invocation.args);
  // OpenAI can persist an omitted optional array as null even when the
  // executed grep succeeded. Treat only that representation as omission;
  // required fields and other malformed history still fail schema validation.
  const historyArgs =
    isRecord(candidate) && candidate['filePaths'] === null
      ? { ...candidate, filePaths: undefined }
      : candidate;
  const parsed = GrepSearchInputSchema.safeParse(historyArgs);
  if (!parsed.success) {
    if (persisted && shouldWarnMalformed(invocation.toolCallId)) {
      logger.warn('Skipping unparseable persisted grep arguments during supersession detection', {
        code: 'tool_projection_rewrite_malformed_grep_history_args',
        toolCallId: invocation.toolCallId,
      });
    }
    return;
  }
  const input = parsed.data;
  return JSON.stringify({
    caseSensitive: input.caseSensitive ?? false,
    contextLines: input.contextLines ?? 0,
    filePaths: input.filePaths ? [...input.filePaths].sort() : [],
    isRegex: input.isRegex ?? false,
    maxResults: input.maxResults ?? 50,
    offset: input.offset ?? 0,
    outputMode: input.outputMode ?? 'files',
    pattern: input.pattern,
    root: input.root ?? null,
  });
}

function parseFileIdentity(
  value: unknown
): Pick<ReadProjectionResult, 'path' | 'rootId' | 'rootName'> | undefined {
  if (!isRecord(value)) {
    return;
  }
  const { path, rootId, rootName } = value;
  if (
    !(
      typeof path === 'string' &&
      path.length > 0 &&
      typeof rootName === 'string' &&
      rootName.length > 0 &&
      (rootId === undefined || (typeof rootId === 'string' && rootId.length > 0))
    )
  ) {
    return;
  }
  return { path, ...(rootId === undefined ? {} : { rootId }), rootName };
}

function sameFile(
  first: Pick<ReadProjectionResult, 'path' | 'rootId' | 'rootName'>,
  second: Pick<ReadProjectionResult, 'path' | 'rootId' | 'rootName'>
): boolean {
  if (first.path !== second.path) {
    return false;
  }
  if (first.rootId && second.rootId) {
    return first.rootId === second.rootId;
  }
  // Results persisted before rootId was added cannot be canonically
  // disambiguated. Preserve their legacy root-name match only when at least
  // one side genuinely lacks the canonical identity.
  return first.rootName === second.rootName;
}

function rangesOverlap(first: ReadProjectionResult, second: ReadProjectionResult): boolean {
  return first.startLine <= second.endLine && second.startLine <= first.endLine;
}

function readWasSuperseded(args: {
  readonly earlier: PreparedToolInvocation;
  readonly later: PreparedToolInvocation;
}): boolean {
  if (
    args.earlier.invocation.toolName !== NATIVE_TOOL_ID.readWorkspaceFile ||
    !args.earlier.read ||
    args.earlier.readIsDedup ||
    args.later.readIsDedup
  ) {
    return false;
  }
  const currentFile = parseFileIdentity(args.later.invocation.result);
  if (!(currentFile && sameFile(args.earlier.read, currentFile))) {
    return false;
  }
  if (
    args.later.invocation.toolName === NATIVE_TOOL_ID.writeWorkspaceFile ||
    args.later.invocation.toolName === NATIVE_TOOL_ID.stringReplaceWorkspaceFile
  ) {
    return true;
  }
  return Boolean(
    args.later.invocation.toolName === NATIVE_TOOL_ID.readWorkspaceFile &&
      args.later.read &&
      rangesOverlap(args.earlier.read, args.later.read)
  );
}

function grepWasSuperseded(
  earlier: PreparedToolInvocation,
  later: PreparedToolInvocation
): boolean {
  return (
    earlier.invocation.toolName === NATIVE_TOOL_ID.grepSearch &&
    later.invocation.toolName === NATIVE_TOOL_ID.grepSearch &&
    earlier.grepKey !== undefined &&
    earlier.grepKey === later.grepKey
  );
}

function prepareInvocation(
  invocation: PersistedToolInvocation,
  persisted: boolean
): PreparedToolInvocation {
  // BST-1248: the memo gates ONLY the warn, never the parse — `read` and
  // `grepKey` feed supersession detection in both directions, so a memoized
  // record must keep acting as a superseder of other, valid records.
  const read =
    invocation.toolName === NATIVE_TOOL_ID.readWorkspaceFile
      ? parseReadProjectionResult(invocation.result)
      : undefined;
  if (
    invocation.toolName === NATIVE_TOOL_ID.readWorkspaceFile &&
    !read &&
    shouldWarnMalformed(invocation.toolCallId)
  ) {
    logger.warn('Skipping malformed persisted read result during supersession detection', {
      code: 'tool_projection_rewrite_malformed_read_history',
      toolCallId: invocation.toolCallId,
    });
  }
  return {
    grepKey:
      invocation.toolName === NATIVE_TOOL_ID.grepSearch
        ? normalizeGrepKey(invocation, persisted)
        : undefined,
    invocation,
    read,
    readIsDedup: isRecord(invocation.result) && invocation.result['dedup'] === true,
  };
}

function collectCandidates(args: {
  readonly current: SuccessfulToolProjection;
  readonly invocations: readonly PersistedToolInvocation[];
}): SupersessionRewriteCandidate[] {
  if (!(isRecord(args.current.input) && args.current.toolCallId)) {
    throw new TypeError('Tracked tool projection input and tool-call id must be present.');
  }
  const history = [
    ...args.invocations.map((invocation) => prepareInvocation(invocation, true)),
    prepareInvocation(
      {
        args: args.current.input,
        modelOutput: undefined,
        result: args.current.result,
        toolCallId: args.current.toolCallId,
        toolName: args.current.toolId,
      },
      false
    ),
  ];
  const candidates: SupersessionRewriteCandidate[] = [];
  for (let earlierIndex = 0; earlierIndex < history.length - 1; earlierIndex += 1) {
    const earlier = history[earlierIndex];
    if (!earlier) {
      continue;
    }
    const later = history
      .slice(earlierIndex + 1)
      .find(
        (candidate) =>
          readWasSuperseded({ earlier, later: candidate }) || grepWasSuperseded(earlier, candidate)
      );
    if (!later) {
      continue;
    }
    const candidate = earlier.read
      ? readCandidate(earlier.invocation, earlier.read, later.invocation)
      : grepCandidate(earlier.invocation);
    if (candidate) {
      candidates.push({
        ...candidate,
        supersededByToolCallId: later.invocation.toolCallId,
      });
    }
  }
  return candidates;
}

/**
 * `modelOutput === undefined` happens for native invocations persisted
 * before `providerMetadata.mastra.modelOutput` existed. Every other consumer
 * of this field (`projection-safe-tool-call-filter.ts`,
 * `projection-aware-token-limiter.ts`) treats absence as normal and skips
 * the part; skipping here (excluding the invocation from the size walk
 * entirely) is strictly safer than throwing, which would abort recency
 * pruning for the WHOLE thread on every later native-tool call (BST-1200
 * review PRRT_kwDOONNKB86XkXki).
 */
export function toRecencyPruneInvocation(
  invocation: PersistedToolInvocation
): RecencyPruneInvocation | undefined {
  if (!isNativeToolId(invocation.toolName)) {
    return;
  }
  if (invocation.modelOutput === undefined) {
    return;
  }
  return {
    args: invocation.args,
    modelOutput: invocation.modelOutput,
    toolCallId: invocation.toolCallId,
    toolName: invocation.toolName,
  };
}

export async function recordSuccessfulToolProjection(
  current: SuccessfulToolProjection,
  dependencies: ToolProjectionRewriteDependencies = {}
): Promise<void> {
  const threadId = current.runtimeData?.memory?.threadId;
  if (!threadId) {
    return;
  }
  if (!current.toolCallId?.trim()) {
    throw new Error('Tool projection supersession requires the current tool-call id.');
  }
  const databaseProvider =
    dependencies.getDatabase ?? (getDatabase as ProjectionRewriteDatabaseProvider);
  const database = await databaseProvider();
  const scan = await listPriorInvocations(database, threadId);
  const candidates = collectCandidates({ current, invocations: scan.invocations });
  const reclaimableChars = candidates.reduce(
    (total, candidate) => total + candidate.reclaimableChars,
    0
  );
  const supersessionCandidateIds = new Set<string>();
  if (reclaimableChars >= TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS) {
    for (const candidate of candidates) {
      supersessionCandidateIds.add(candidate.toolCallId);
    }
    const insertedIds = await commitProjectionRewriteCandidates(database, threadId, candidates);
    if (insertedIds.size > 0) {
      (dependencies.resetLoopGuards ?? resetToolCallLoopGuards)(
        readStateScope(current.runtimeData)
      );
      logger.info(
        {
          code: 'tool_projection_rewrite_batch_committed',
          inserted: insertedIds.size,
          reclaimableChars,
          threadId,
        },
        'committed superseded native-tool projection rewrite batch'
      );
    }
  }

  await runRecencyPruneScan(
    { runtimeData: current.runtimeData, threadId },
    { ...dependencies, excludeToolCallIds: supersessionCandidateIds, priorScan: scan }
  );
}

/** Run Layer 2's recency-prune scan for a thread without a synthetic tool event. */
export async function runRecencyPruneScan(
  input: RunRecencyPruneScanInput,
  dependencies: RecencyPruneScanDependencies = {}
): Promise<{ prunedCount: number }> {
  if (!input.threadId.trim()) {
    throw new Error('Recency-prune scan requires a non-empty thread id.');
  }
  const databaseProvider =
    dependencies.getDatabase ?? (getDatabase as ProjectionRewriteDatabaseProvider);
  const database = await databaseProvider();
  const scan = dependencies.priorScan ?? (await listPriorInvocations(database, input.threadId));
  const pruneEligibleInvocations: RecencyPruneInvocation[] = [];
  for (const invocation of scan.invocations) {
    if (dependencies.excludeToolCallIds?.has(invocation.toolCallId)) {
      continue;
    }
    const pruneInvocation = toRecencyPruneInvocation(invocation);
    if (pruneInvocation) {
      pruneEligibleInvocations.push(pruneInvocation);
    }
  }
  const pruneCandidates = selectRecencyPruneCandidates({
    currentTurnToolCallIds: scan.currentTurnToolCallIds,
    invocations: pruneEligibleInvocations,
  });
  if (pruneCandidates.length === 0) {
    return { prunedCount: 0 };
  }
  const prunedIds = await commitProjectionRewriteCandidates(
    database,
    input.threadId,
    pruneCandidates
  );
  if (prunedIds.size === 0) {
    return { prunedCount: 0 };
  }
  const prunedReclaimableChars = pruneCandidates.reduce(
    (total, candidate) =>
      prunedIds.has(candidate.toolCallId) ? total + candidate.reclaimableChars : total,
    0
  );
  (dependencies.resetLoopGuards ?? resetToolCallLoopGuards)(readStateScope(input.runtimeData));
  logger.info(
    {
      code: 'tool_projection_prune_batch_committed',
      prunedRows: prunedIds.size,
      reclaimableChars: prunedReclaimableChars,
      threadId: input.threadId,
    },
    'committed recency-pruned native-tool projection rewrite batch'
  );
  return { prunedCount: prunedIds.size };
}

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

interface ExecutableTool {
  readonly execute: (input: unknown, context?: ToolExecuteRunContext) => Promise<unknown> | unknown;
}

const REWRITE_TRACKED_TOOL_IDS = [
  NATIVE_TOOL_ID.grepSearch,
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
  NATIVE_TOOL_ID.writeWorkspaceFile,
] as const;

function shouldRecordResult(
  toolId: (typeof REWRITE_TRACKED_TOOL_IDS)[number],
  result: unknown
): boolean {
  if (!isRecord(result)) {
    return false;
  }
  if (toolId === NATIVE_TOOL_ID.readWorkspaceFile) {
    return result['dedup'] !== true && parseReadProjectionResult(result) !== undefined;
  }
  if (toolId === NATIVE_TOOL_ID.grepSearch) {
    return result['outputMode'] === 'files' || result['outputMode'] === 'content';
  }
  return parseFileIdentity(result) !== undefined;
}

/** Decorate only the four desktop tools that can supersede persisted reads. */
export function applyToolProjectionRewriteRecording(
  tools: MastraTools,
  runtimeData: RuntimeData | undefined
): MastraTools {
  if (!runtimeData?.toolProjectionRewriteLookup) {
    return tools;
  }
  const decorated: MastraTools = { ...tools };
  for (const toolId of REWRITE_TRACKED_TOOL_IDS) {
    const tool = tools[toolId];
    if (!tool) {
      continue;
    }
    if (!(typeof tool === 'object' && 'execute' in tool && typeof tool.execute === 'function')) {
      throw new TypeError(`${toolId} must expose an execute function for projection rewriting.`);
    }
    const executable = tool as unknown as ExecutableTool;
    decorated[toolId] = {
      ...tool,
      execute: async (input: unknown, context?: ToolExecuteRunContext) => {
        const result = await executable.execute(input, context);
        if (shouldRecordResult(toolId, result)) {
          try {
            await recordSuccessfulToolProjection({
              input: resolveToolExecuteInputCandidate(NATIVE_TOOL_INPUT_SCHEMAS[toolId], input),
              result,
              runtimeData,
              toolCallId: readToolCallId(context),
              toolId,
            });
          } catch (error) {
            logger.error('Tool projection rewrite bookkeeping failed; tool result preserved', {
              code: 'tool_projection_rewrite_recording_failed',
              error: redactToolErrorForLog(error),
              toolId,
            });
          }
        }
        return result;
      },
    } as typeof tool;
  }
  return decorated;
}
