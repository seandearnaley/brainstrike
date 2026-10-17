import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  GrepSearchInputSchema,
  type ToolProjectionRewriteEntry,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { Schema } from 'effect';
import {
  type GrepToolResult,
  grepProjectionHeaderPrefix,
  parseGrepToolResult,
} from './grep-search-result-contract.js';
import {
  projectReadWorkspaceFileModelOutput,
  resolveReadWorkspaceFileRootLabel,
} from './read-workspace-file-model-projection.js';
import { readProjectionHeaderPrefix } from './read-workspace-file-result-contract.js';
import { redactToolErrorForLog } from './tool-execute-support.js';
import { decodedPersistedModelOutputChars } from './tool-projection-prune.js';
import {
  decodedWorkspaceTextModelOutputChars,
  escapeProjectionPathLineBreaks,
} from './workspace-model-projection-helpers.js';

const decodeGrepHistory = Schema.decodeUnknownResult(GrepSearchInputSchema, {
  onExcessProperty: 'error',
});

const logger = createLogger('ToolProjectionSupersession');

/** Cline's 64 KiB stale-read compaction trigger, measured in projected chars. */
export const TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS = 65_536;

export interface ReadProjectionResult {
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
export type SupersessionRewriteCandidate = Extract<RewriteCandidate, { kind: 'supersession' }>;

/**
 * One committed tool call as supersession detection reads it: its input, its
 * raw result and, when committed, the model-facing projection it shipped.
 */
export interface PersistedToolInvocation {
  readonly args: Record<string, unknown>;
  readonly modelOutput: unknown;
  readonly result: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

/**
 * Re-projects a grep result persisted before model outputs were stored. Only
 * the desktop legacy history has such rows; the host commits every projection.
 */
export type LegacyGrepReprojection = (result: unknown) => string;

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

export function parseReadProjectionResult(value: unknown): ReadProjectionResult | undefined {
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
  invocation: PersistedToolInvocation,
  reprojectLegacyGrep: LegacyGrepReprojection | undefined
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
  const originalChars = measurePersistedProjectionChars(invocation, () => {
    if (!reprojectLegacyGrep) {
      throw new Error('A grep result without a committed projection needs a legacy re-projection.');
    }
    return reprojectLegacyGrep(invocation.result);
  });
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
  const candidate = invocation.args;
  // OpenAI can persist an omitted optional array as null even when the
  // executed grep succeeded. Treat only that representation as omission;
  // required fields and other malformed history still fail schema validation.
  const historyArgs =
    isRecord(candidate) && candidate['filePaths'] === null
      ? Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'filePaths'))
      : candidate;
  const parsed = decodeGrepHistory(historyArgs);
  if (parsed._tag === 'Failure') {
    if (persisted && shouldWarnMalformed(invocation.toolCallId)) {
      logger.warn('Skipping unparseable persisted grep arguments during supersession detection', {
        code: 'tool_projection_rewrite_malformed_grep_history_args',
        toolCallId: invocation.toolCallId,
      });
    }
    return;
  }
  const input = parsed.success;
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

export function parseFileIdentity(
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

/**
 * Layer 1 (BST-1192) stale-read detection over committed calls, oldest
 * first: an earlier read superseded by a later overlapping read or a write or
 * edit of the same file, and an earlier grep repeated with the same key.
 * `current` is the just-finished call when detection runs right after it.
 */
export function collectSupersessionCandidates(args: {
  readonly current?: PersistedToolInvocation;
  readonly invocations: readonly PersistedToolInvocation[];
  readonly reprojectLegacyGrep?: LegacyGrepReprojection;
}): SupersessionRewriteCandidate[] {
  const history = [
    ...args.invocations.map((invocation) => prepareInvocation(invocation, true)),
    ...(args.current ? [prepareInvocation(args.current, false)] : []),
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
      : grepCandidate(earlier.invocation, args.reprojectLegacyGrep);
    if (candidate) {
      candidates.push({
        ...candidate,
        supersededByToolCallId: later.invocation.toolCallId,
      });
    }
  }
  return candidates;
}
