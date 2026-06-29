import type { GrepSearchInput, RuntimeData, RuntimeWorkspaceRoot } from '@brainstrike/agent';
import {
  fitItemsToCharBudget,
  normalizeOptionalText,
  resolveWorkspaceIndexEmbeddingSetId,
} from '@brainstrike/agent';
import type {
  BrainstrikeDbExecutionClient,
  GrepMatch,
  GrepSearchResult,
  LineMatcher,
} from '@brainstrike/db';
import {
  createGrepLineMatcher,
  FileChunkRepository,
  GrepSearchService,
  TursoFileChunkRepository,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import { getDatabase, getDatabaseRuntimeDiagnostics } from '../db-main';
import { type LiveGrepResult, runLiveGrep } from './live-grep';
import { getWorkspaceRoots, resolveWorkspaceRoot } from './workspace-roots';

const logger = createLogger('AssistantGrepSearchTool');

export const GREP_SEARCH_TOOL_ID = 'brainstrike.grepSearch' as const;

/**
 * Which engine produced a match:
 * - 'index' — from the indexed PGlite file chunks (may be STALE after an edit).
 * - 'live'  — from a fresh on-disk pass (ripgrep / JS-walk); reflects the file
 *             as it is NOW, so just-edited / unindexed content shows up here.
 * - 'both'  — the same (path, line) was found by both passes (fresh + indexed).
 */
export type GrepMatchSource = 'index' | 'live' | 'both';

/** A grep match labelled with the engine(s) that produced it. */
export type LabeledGrepMatch = GrepMatch & { source: GrepMatchSource };

const DEFAULT_CONTENT_MATCHES = 50;
const TURSO_GREP_CONTENT_GRAMS_CHECK_ID = 'search.grep-content-grams';
const TURSO_GREP_SEARCH_BOOTSTRAP_UNAVAILABLE = `brainstrike.grepSearch requires a ready Turso bootstrap report with ${TURSO_GREP_CONTENT_GRAMS_CHECK_ID} passed.`;
type PgliteGrepDatabase = ConstructorParameters<typeof FileChunkRepository>[0];
/**
 * Internal match cap for 'files' mode aggregation. The service caps the
 * candidate pool at 500 files regardless, so this only bounds per-file match
 * counting, not the file scan itself.
 */
const FILES_MODE_INTERNAL_MATCH_CAP = 2000;

export interface GrepFileSummary {
  /** Line number of the first match in this file. */
  firstLine: number;
  /** Matches counted in this file (within the internal counting cap). */
  matchCount: number;
  path: string;
  /** Owning workspace root id; null for legacy/unrooted files. */
  rootId?: string | null;
  /** Owning workspace root display name; null when unrooted. */
  rootName?: string | null;
  /**
   * Which engine(s) contributed matches in this file: 'live' (fresh on disk),
   * 'index' (from the possibly-stale index), or 'both'.
   */
  source: GrepMatchSource;
}

interface GrepToolResultBase {
  /** Phase-1 candidate pool hit its limit — more files may contain matches. */
  candidatesTruncated: boolean;
  /** Actionable next step when the result was truncated. */
  hint?: string;
  /**
   * The engine used for the LIVE (on-disk) pass: 'ripgrep', 'js-walk' (rg
   * absent/failed), or 'skipped' (no live pass ran this call).
   */
  liveEngine: LiveGrepResult['engine'];
  /** Non-silent note when the live pass degraded or hit a cap; omitted when clean. */
  liveNote?: string;
  offset: number;
  /** Phase 1 ran without a trigram prefilter (regex had no extractable literal). */
  scanLimited: boolean;
  /** Unique (path, line) matches found (post-deduplication, pre-cap). */
  totalMatches: number;
  truncated: boolean;
}

export interface GrepFilesToolResult extends GrepToolResultBase {
  files: GrepFileSummary[];
  outputMode: 'files';
  totalFiles: number;
}

export interface GrepContentToolResult extends GrepToolResultBase {
  matches: LabeledGrepMatch[];
  outputMode: 'content';
  /** Chunks that matched but lack startLine metadata (cannot report path:line). */
  skippedMissingLineMetadata: number;
}

export type GrepToolResult = GrepFilesToolResult | GrepContentToolResult;

function isTursoSearchDatabase(db: unknown): boolean {
  const capabilities = (db as { capabilities?: { liveQuery?: unknown } } | null)?.capabilities;
  return capabilities?.liveQuery === false;
}

async function assertReadyTursoGrepBootstrap(): Promise<void> {
  const diagnostics = await getDatabaseRuntimeDiagnostics();
  const report = diagnostics.profileBootstrapReport;
  const grepCheck = report?.checks.find((check) => check.id === TURSO_GREP_CONTENT_GRAMS_CHECK_ID);
  if (
    !report?.ready ||
    report.phase !== 'ready' ||
    report.runtime.engine !== 'turso' ||
    report.failure ||
    grepCheck?.required !== true ||
    grepCheck.status !== 'passed'
  ) {
    throw new Error(TURSO_GREP_SEARCH_BOOTSTRAP_UNAVAILABLE);
  }
}

async function createIndexedGrepSearchService(db: unknown): Promise<GrepSearchService> {
  if (isTursoSearchDatabase(db)) {
    await assertReadyTursoGrepBootstrap();
    return new GrepSearchService(new TursoFileChunkRepository(db as BrainstrikeDbExecutionClient));
  }
  return new GrepSearchService(new FileChunkRepository(db as PgliteGrepDatabase));
}

/**
 * The merged (index + live) match set the result builders consume. Mirrors
 * {@link GrepSearchResult} (so the existing token-budget/paging logic is
 * UNCHANGED) but carries labelled matches and the live-pass metadata.
 */
interface MergedGrepResult {
  candidatesTruncated: boolean;
  liveEngine: LiveGrepResult['engine'];
  liveNote?: string;
  matches: LabeledGrepMatch[];
  scanLimited: boolean;
  skippedMissingLineMetadata: number;
  /** Unique merged (rootId, path, line) matches before the cap. */
  totalMatches: number;
  truncated: boolean;
}

/**
 * Merge the indexed and live match sets into one labelled, de-duplicated set.
 *
 * Dedup key is (rootId, path, line) — the same key the indexed service uses for
 * its own cross-chunk dedupe — so a line found by BOTH passes appears ONCE,
 * labelled 'both'. Index-only lines are 'index'; live-only lines are 'live'
 * (these are the FRESH lines the index would miss after an edit). When both have
 * the line, the LIVE row wins for content (it reflects the file as it is now).
 *
 * `totalMatches` preserves the index's UNCAPPED unique count as a floor and adds
 * the live-only contributions (live keys absent from the index's MATERIALIZED
 * set), so pagination stays monotonic and the cap-terminal hint still fires; when
 * the live pass returns nothing, `totalMatches` equals the index total exactly
 * (the pre-hybrid behaviour is unchanged). `truncated` ORs both passes' own
 * truncation flags so the existing budget logic drives the continuation hint.
 */
function mergeGrepMatches(
  indexResult: GrepSearchResult,
  liveResult: LiveGrepResult
): MergedGrepResult {
  // Bucket matches by their (path, line) base key; a bucket holds more than one
  // entry only when two roots share a relative path+line.
  const buckets = new Map<string, LabeledGrepMatch[]>();
  const baseKeyOf = (match: GrepMatch): string => `${match.path}:${match.line}`;
  // Two matches are the same physical line when path+line agree AND their root
  // ids are COMPATIBLE — equal, or either side has no rootId. A null/undefined
  // rootId only arises in the single-root legacy path (no cross-root ambiguity),
  // so an index row (root_id from file_records, often null for legacy rows) still
  // dedupes against the live row (rootId from the resolved workspace root)
  // instead of double-reporting the same line.
  const rootCompatible = (a: GrepMatch, b: GrepMatch): boolean =>
    a.rootId === null ||
    a.rootId === undefined ||
    b.rootId === null ||
    b.rootId === undefined ||
    a.rootId === b.rootId;

  const pushToBucket = (key: string, labelled: LabeledGrepMatch): void => {
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(labelled);
    } else {
      buckets.set(key, [labelled]);
    }
  };

  for (const match of indexResult.matches) {
    pushToBucket(baseKeyOf(match), { ...match, source: 'index' });
  }

  // Count live rows that the index did NOT already materialize — these are the
  // FRESH on-disk matches the index missed. (A live row colliding with an index
  // row beyond the materialization cap is rare and only over-counts the total
  // slightly — a safe upper bound that keeps the hint monotonic.)
  let liveOnlyAdded = 0;
  for (const match of liveResult.matches) {
    const key = baseKeyOf(match);
    const twin = buckets.get(key)?.find((existing) => rootCompatible(existing, match));
    if (twin) {
      // Live wins for content (fresh bytes); the shared line is labelled 'both'.
      Object.assign(twin, match, { source: 'both' as GrepMatchSource });
      continue;
    }
    liveOnlyAdded += 1;
    pushToBucket(key, { ...match, source: 'live' });
  }

  const matches = Array.from(buckets.values())
    .flat()
    .sort(
      (a, b) =>
        (a.rootName ?? '').localeCompare(b.rootName ?? '') ||
        a.path.localeCompare(b.path) ||
        a.line - b.line
    );

  // Floor at the index's uncapped total (so a result the live pass doesn't change
  // keeps the index pagination semantics), then add the fresh live-only rows.
  const totalMatches = indexResult.totalMatches + liveOnlyAdded;

  return {
    matches,
    totalMatches,
    // Truncated when EITHER pass was truncated (the index cap, or the live caps).
    truncated: indexResult.truncated || liveResult.truncated,
    candidatesTruncated: indexResult.candidatesTruncated,
    scanLimited: indexResult.scanLimited,
    skippedMissingLineMetadata: indexResult.skippedMissingLineMetadata,
    liveEngine: liveResult.engine,
    ...(liveResult.note ? { liveNote: liveResult.note } : {}),
  };
}

/** Fold a new match's source into a file summary's running source label. */
function mergeSource(existing: GrepMatchSource, next: GrepMatchSource): GrepMatchSource {
  return existing === next ? existing : 'both';
}

function aggregateFileSummaries(matches: readonly LabeledGrepMatch[]): GrepFileSummary[] {
  // Key by (root, path): two open roots can share a relative path, and keying
  // on path alone would merge their counts into one bogus summary.
  const byKey = new Map<string, GrepFileSummary>();
  for (const match of matches) {
    const key = `${match.rootId ?? ''}\u0000${match.path}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.matchCount += 1;
      existing.firstLine = Math.min(existing.firstLine, match.line);
      existing.source = mergeSource(existing.source, match.source);
    } else {
      byKey.set(key, {
        path: match.path,
        matchCount: 1,
        firstLine: match.line,
        source: match.source,
        ...(match.rootId === undefined ? {} : { rootId: match.rootId }),
        ...(match.rootName === undefined ? {} : { rootName: match.rootName }),
      });
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) =>
      b.matchCount - a.matchCount ||
      (a.rootName ?? '').localeCompare(b.rootName ?? '') ||
      a.path.localeCompare(b.path)
  );
}

function buildFilesResult(mergedResult: MergedGrepResult, offset: number): GrepFilesToolResult {
  const allFiles = aggregateFileSummaries(mergedResult.matches);
  const pagedFiles = allFiles.slice(offset);

  // The hint is part of the fitted candidate so it can never push the final
  // result back over the budget.
  const { result } = fitItemsToCharBudget(pagedFiles, (files): GrepFilesToolResult => {
    // Truncated when files were dropped (by paging or budget fitting) or the
    // service hit its internal match cap (per-file counts may be incomplete).
    const truncated = files.length + offset < allFiles.length || mergedResult.truncated;
    // A continuation hint must always ADVANCE: if even one summary cannot fit
    // the budget, skip past it rather than re-suggesting the same offset.
    const nextOffset =
      files.length === 0 && pagedFiles.length > 0 ? offset + 1 : offset + files.length;
    const hint =
      truncated || mergedResult.candidatesTruncated
        ? `Showing ${files.length} of ${allFiles.length} matching files. ` +
          `Continue with offset: ${nextOffset}, or call again with outputMode: 'content' and ` +
          'filePaths set to the most relevant paths to see the matching lines.'
        : undefined;
    return {
      outputMode: 'files',
      files,
      totalFiles: allFiles.length,
      totalMatches: mergedResult.totalMatches,
      offset,
      truncated,
      candidatesTruncated: mergedResult.candidatesTruncated,
      scanLimited: mergedResult.scanLimited,
      liveEngine: mergedResult.liveEngine,
      ...(mergedResult.liveNote ? { liveNote: mergedResult.liveNote } : {}),
      ...(hint ? { hint } : {}),
    };
  });
  return result;
}

function buildContentHint(
  mergedResult: MergedGrepResult,
  offset: number,
  shownCount: number,
  hadPageItems: boolean,
  serviceCap: number
): string | undefined {
  const truncated = offset + shownCount < mergedResult.totalMatches;
  if (!truncated) {
    return;
  }
  // A single match (long line × contextLines) can exceed the whole budget; a
  // hint repeating the same offset would loop the model. Skip past it.
  if (shownCount === 0 && hadPageItems) {
    return (
      `The match at offset ${offset} is too large to display within the output budget ` +
      `(very long line). Continue with offset: ${offset + 1} and contextLines: 0, or scope with filePaths.`
    );
  }
  const nextOffset = offset + shownCount;
  // The service only materializes serviceCap matches, so offsets at/beyond the
  // cap can never return more data — make the cap terminal instead of
  // suggesting an offset that yields the same empty page.
  if (nextOffset >= serviceCap) {
    return (
      `Pagination cap reached (${serviceCap} of ${mergedResult.totalMatches} matches reachable by offset). ` +
      'Narrow with filePaths or a more specific pattern to see the remaining matches.'
    );
  }
  return (
    `Showing matches ${offset + 1}-${nextOffset} of ${mergedResult.totalMatches}. ` +
    `Continue with offset: ${nextOffset}, scope with filePaths, or set contextLines: 0 ` +
    'to fit more matches per call.'
  );
}

function buildContentResult(
  mergedResult: MergedGrepResult,
  offset: number,
  requestedMatches: number,
  serviceCap: number
): GrepContentToolResult {
  const pagedMatches = mergedResult.matches.slice(offset, offset + requestedMatches);

  const { result } = fitItemsToCharBudget(pagedMatches, (matches): GrepContentToolResult => {
    const truncated = offset + matches.length < mergedResult.totalMatches;
    const hint = buildContentHint(
      mergedResult,
      offset,
      matches.length,
      pagedMatches.length > 0,
      serviceCap
    );
    return {
      outputMode: 'content',
      matches,
      totalMatches: mergedResult.totalMatches,
      offset,
      truncated,
      candidatesTruncated: mergedResult.candidatesTruncated,
      scanLimited: mergedResult.scanLimited,
      skippedMissingLineMetadata: mergedResult.skippedMissingLineMetadata,
      liveEngine: mergedResult.liveEngine,
      ...(mergedResult.liveNote ? { liveNote: mergedResult.liveNote } : {}),
      ...(hint ? { hint } : {}),
    };
  });
  return result;
}

/**
 * Run the live pass, but NEVER let it fail the grep. `runLiveGrep` already
 * degrades a missing/failing rg to the JS walk internally; this wrapper is a
 * last-resort guard so any UNEXPECTED throw (programming error, OS quirk) still
 * returns index-only results with a non-silent note instead of throwing.
 */
async function runLiveGrepSafely(args: {
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  contextLines: number;
  roots: readonly RuntimeWorkspaceRoot[];
  filePaths?: readonly string[];
  matcher: LineMatcher;
}): Promise<LiveGrepResult> {
  try {
    return await runLiveGrep(
      {
        pattern: args.pattern,
        isRegex: args.isRegex,
        caseSensitive: args.caseSensitive,
        contextLines: args.contextLines,
        roots: args.roots,
        ...(args.filePaths === undefined ? {} : { filePaths: args.filePaths }),
      },
      args.matcher
    );
  } catch (error) {
    logger.error('live grep pass threw unexpectedly; returning index-only results', { error });
    return {
      matches: [],
      engine: 'skipped',
      truncated: false,
      note: 'The live (on-disk) pass could not run this call, so results reflect the index only (which may be stale after recent edits).',
    };
  }
}

/**
 * The roots the LIVE pass scopes to. An explicit `root` scopes to that one open
 * folder (same as the index path's `rootId` filter); omitting it covers every
 * open root (matching the index path searching all roots). A live pass that
 * cannot resolve any path-backed root yields an empty root list (live skipped).
 */
function resolveLiveRoots(
  runtimeData: RuntimeData | undefined,
  rootInput: string | undefined
): RuntimeWorkspaceRoot[] {
  if (rootInput === undefined) {
    return getWorkspaceRoots(runtimeData);
  }
  // `root` was already validated by resolveWorkspaceRoot in the caller, so this
  // re-resolution cannot throw a new error here; scope the live pass to it.
  return [resolveWorkspaceRoot(runtimeData, rootInput)];
}

/** Run the INDEXED (PGlite trigram) search — unchanged behaviour, extracted for clarity. */
function runIndexSearch(args: {
  service: GrepSearchService;
  input: GrepSearchInput;
  contextLines: number;
  serviceMaxResults: number;
  embeddingSetId: string | undefined;
  rootId: string | undefined;
}): Promise<GrepSearchResult> {
  const { input } = args;
  return args.service.search({
    pattern: input.pattern,
    ...(input.isRegex === undefined ? {} : { isRegex: input.isRegex }),
    ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
    ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
    contextLines: args.contextLines,
    maxResults: args.serviceMaxResults,
    ...(args.embeddingSetId === undefined ? {} : { embeddingSetId: args.embeddingSetId }),
    ...(args.rootId === undefined ? {} : { rootId: args.rootId }),
  });
}

export async function runGrepSearch(
  input: GrepSearchInput,
  runtimeData: RuntimeData | undefined
): Promise<GrepToolResult> {
  const db = await getDatabase();
  const service = await createIndexedGrepSearchService(db);

  const embeddingSetId =
    normalizeOptionalText(runtimeData?.embeddingSetId) ??
    resolveWorkspaceIndexEmbeddingSetId(runtimeData) ??
    undefined;

  // An explicit `root` scopes the search to one open folder. Resolve it BEFORE
  // the try/catch so an unknown/ambiguous folder surfaces its actionable
  // "Open folders: ..." message to the model instead of the generic catch.
  // Omitting `root` searches every root (results stay labelled either way).
  const rootId =
    input.root === undefined ? undefined : resolveWorkspaceRoot(runtimeData, input.root).rootId;

  const outputMode = input.outputMode ?? 'files';
  const offset = input.offset ?? 0;
  const requestedMatches = input.maxResults ?? DEFAULT_CONTENT_MATCHES;
  // The service slices its accumulated matches to maxResults, so pagination
  // must request offset + page size; files mode counts matches per file and
  // needs the larger internal cap to keep counts meaningful.
  const serviceMaxResults =
    outputMode === 'files'
      ? FILES_MODE_INTERNAL_MATCH_CAP
      : Math.min(offset + requestedMatches, FILES_MODE_INTERNAL_MATCH_CAP);

  const isRegex = input.isRegex ?? false;
  const caseSensitive = input.caseSensitive ?? false;
  const contextLines = outputMode === 'files' ? 0 : (input.contextLines ?? 1);
  // Build the authoritative matcher up front: an invalid regex throws here
  // (BEFORE any DB or disk work), preserving the no-coercion contract, and the
  // SAME matcher instance drives the live pass so live + indexed match
  // semantics can never diverge.
  const liveMatcher = createGrepLineMatcher(input.pattern, isRegex, caseSensitive);
  const liveRoots = resolveLiveRoots(runtimeData, input.root);

  try {
    const serviceResult = await runIndexSearch({
      service,
      input,
      contextLines,
      serviceMaxResults,
      embeddingSetId,
      rootId,
    });

    const liveResult = await runLiveGrepSafely({
      pattern: input.pattern,
      isRegex,
      caseSensitive,
      contextLines,
      roots: liveRoots,
      ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
      matcher: liveMatcher,
    });

    const merged = mergeGrepMatches(serviceResult, liveResult);

    return outputMode === 'files'
      ? buildFilesResult(merged, offset)
      : buildContentResult(merged, offset, requestedMatches, FILES_MODE_INTERNAL_MATCH_CAP);
  } catch (error) {
    logger.error('grepSearch failed', { error, pattern: input.pattern.slice(0, 100) });
    const message = error instanceof Error ? error.message : String(error);
    // Rethrow only known-safe service validation messages; everything else
    // (raw PGlite/SQL errors) maps to a generic message so internal details
    // never reach the model (same convention as retrieval-tool.ts).
    const knownSafeMessages = [
      /^Invalid regular expression pattern:/,
      /^Grep pattern must be at least \d+ characters/,
      /^findGrepCandidates filePaths limit exceeded/,
    ];
    if (knownSafeMessages.some((re) => re.test(message))) {
      throw error;
    }
    throw new Error('Unable to perform grep search right now. Try again.');
  }
}
