import {
  fitItemsToCharBudget,
  type GrepSearchInput,
  type RuntimeData,
  type RuntimeWorkspaceRoot,
} from '@brainstrike/agent';
import { isBoundaryRefusal, NATIVE_TOOL_ID, ToolInputError } from '@brainstrike/assistant-contract';
import {
  type GrepContentToolResult,
  type GrepFileSummary,
  type GrepFilesToolResult,
  type GrepMatchSource,
  type GrepToolResult,
  type LabeledGrepMatch,
  type ModelFacingGrepMatch,
  parseGrepToolResult,
} from '@brainstrike/host-capabilities/grep-search-result-contract';
import { createLogger } from '@brainstrike/logging';
import { createGrepLineMatcher, type LineMatcher } from '@brainstrike/utils/grep-line-matcher';
import type {
  GrepMatch,
  GrepSearchOptions,
  GrepSearchResult,
} from '@brainstrike/utils/grep-search';
import { resolveGrepFilePaths } from './grep-file-paths';
import { resolveZeroMatchProbeNote, type ZeroMatchProbeCount } from './grep-zero-match-probes';
import { type LiveGrepResult, probeExcludedPathMatches, runLiveGrep } from './live-grep';
import {
  describeOpenRootTopology,
  type OpenRootTopology,
  resolveWorkspaceSearchScope,
  type WorkspaceSearchScope,
} from './workspace-roots';

const logger = createLogger('AssistantGrepSearchTool');

export const GREP_SEARCH_TOOL_ID = NATIVE_TOOL_ID.grepSearch;

/**
 * The INDEXED half of a grep: the trigram candidate search over Main's PGlite
 * file chunks. Main binds the store directly; the agent host binds a typed
 * read of it. The live (ripgrep) half always runs where the tool runs.
 */
export type GrepIndexSearch = (options: GrepSearchOptions) => Promise<GrepSearchResult>;

/**
 * Which engine produced a match:
 * - 'index' — from the indexed PGlite file chunks (may be STALE after an edit).
 * - 'live'  — from a fresh on-disk pass (ripgrep / JS-walk); reflects the file
 *             as it is NOW, so just-edited / unindexed content shows up here.
 * - 'both'  — the same (path, line) was found by both passes (fresh + indexed).
 */
/** Drop the internal chunk-locator fields, keeping only model-facing data. */
function toModelFacingMatch(match: LabeledGrepMatch): ModelFacingGrepMatch {
  return {
    after: match.after,
    before: match.before,
    line: match.line,
    lineText: match.lineText,
    path: match.path,
    source: match.source,
    ...(match.rootId === undefined ? {} : { rootId: match.rootId }),
    ...(match.rootName === undefined ? {} : { rootName: match.rootName }),
  };
}

const DEFAULT_CONTENT_MATCHES = 50;
/**
 * Internal match cap requested from the index pass, in BOTH output modes. The
 * service caps the candidate pool at 500 files regardless, so this only bounds
 * how many matches are materialized, not the file scan itself.
 *
 * Content mode used to request only `offset + maxResults`. That bought nothing
 * — `GrepSearchService.search` accumulates every match from its candidates and
 * `maxResults` only slices the finished array, so a smaller request skips no DB
 * or matching work — while creating the merge's attribution hole: with the index
 * arm capped, its unmaterialized matches are indistinguishable from lines the
 * live pass discovered fresh. It also contradicted the model-facing hint, which
 * already reports THIS constant as the pagination cap.
 */
const INTERNAL_MATCH_CAP = 2000;
/** Small index candidate pool for count-only zero-match steering probes. */
export const PROBE_INDEX_CANDIDATE_LIMIT = 50;
/** Probe rows stay tightly bounded; the uncapped `totalMatches` is the count source. */
export const PROBE_INDEX_MAX_RESULTS = 20;
const REDACTED_GREP_PATTERN_LOG_VALUE = { redacted: true } as const;

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
  probeNote?: string;
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
 * `totalMatches` preserves the index's UNCAPPED unique count as a floor; when the
 * live pass returns nothing it equals the index total exactly (the pre-hybrid
 * behaviour is unchanged). `truncated` carries ONLY the index arm's
 * output/paging truncation (BST-1247); the live pass's caps are substrate
 * conditions and merge into `candidatesTruncated`/`scanLimited`, which the
 * hint gate unions so continuation guidance still fires.
 *
 * Counting the live-only contribution depends on whether the index arm
 * MATERIALIZED everything it counted (see {@link resolveTotalMatches}).
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

  const totalMatches = resolveTotalMatches({
    indexResult,
    liveOnlyAdded,
    mergedCount: matches.length,
  });

  return {
    // BST-1247: substrate caps merge from BOTH arms into their own fields;
    // `truncated` carries ONLY the index arm's output/paging truncation. The
    // live pass has no output paging of its own — its folded `truncated` is
    // pure substrate, and folding it here was the first half of the OR-fold
    // that made waste_score blame the model for a degraded engine.
    candidatesTruncated: indexResult.candidatesTruncated || liveResult.candidatesTruncated,
    liveEngine: liveResult.engine,
    matches,
    scanLimited: indexResult.scanLimited || liveResult.scanLimited,
    skippedMissingLineMetadata: indexResult.skippedMissingLineMetadata,
    totalMatches,
    truncated: indexResult.truncated,
    ...(liveResult.note ? { liveNote: liveResult.note } : {}),
  };
}

/**
 * The merged unique-match total.
 *
 * The index arm reports an UNCAPPED unique count (`indexResult.totalMatches`)
 * but materializes at most `INTERNAL_MATCH_CAP` rows, so "live rows with no twin
 * among the materialized index rows" counts NEW lines only while the index
 * materialized everything it counted. That is now the normal case for both
 * modes, so the exact sum is the normal path.
 *
 * Beyond the cap the attribution genuinely breaks: an on-disk line the index
 * counted but did not materialize is indistinguishable from a fresh live-only
 * one. Two bounds are still known to be real, so take the larger:
 *
 * - `indexResult.totalMatches` — the index's own uncapped count.
 * - `mergedCount` — distinct locations actually materialized here.
 *
 * Neither can over-report. This is deliberately a BOUND, not the union: with the
 * index capped and the live pass ALSO limited (its per-file `--max-count`, size
 * caps, or the candidate cap), the merged set can sit below the index total
 * while still holding fresh live-only rows, and those are then absorbed rather
 * than added. Raising `INTERNAL_MATCH_CAP` is what shrinks that window; adding
 * `liveOnlyAdded` on top of a capped index total is what over-counted before
 * (measured on a 61-hit file: 117 at `maxResults: 5`, 102 at 20, 72 at the
 * default 50) and must not come back.
 */
function resolveTotalMatches(args: {
  indexResult: GrepSearchResult;
  liveOnlyAdded: number;
  mergedCount: number;
}): number {
  if (args.indexResult.truncated) {
    return Math.max(args.indexResult.totalMatches, args.mergedCount);
  }
  return args.indexResult.totalMatches + args.liveOnlyAdded;
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
        firstLine: match.line,
        matchCount: 1,
        path: match.path,
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

/**
 * Refinement guidance for a result whose search limits may have hidden matches
 * but where offset paging cannot reach them. The model projection REQUIRES
 * guidance on every limited result (truncated/scanLimited/candidatesTruncated)
 * — a limited result without a hint fails the whole run (BST-951).
 *
 * The scan-limited note must preserve regex semantics: this state only arises
 * for isRegex: true patterns, so advising isRegex: false would turn the
 * pattern into a literal-string search for DIFFERENT matches.
 */
function buildRefinementHint(args: { scanLimited: boolean; suggestContentMode: boolean }): string {
  const scanNote = args.scanLimited
    ? ' The regex had no long guaranteed literal for the index prefilter — rewrite it to include a ≥3-character literal, or split alternations into separate searches, to cover more of the workspace.'
    : '';
  // Files mode is a survey; when its file list is complete enough, the natural
  // next step is drilling into content, not only re-running a narrower search.
  const nextStep = args.suggestContentMode
    ? "Call again with outputMode: 'content' and filePaths set to the most relevant paths to see the matching lines, or narrow"
    : 'Narrow';
  return (
    'Search limits may have hidden additional matches that offset paging cannot reach. ' +
    `${nextStep} with filePaths or use a more specific or different pattern.${scanNote}`
  );
}

function buildFilesHint(args: {
  candidatesTruncated: boolean;
  filesShown: number;
  hasPagedFiles: boolean;
  offset: number;
  scanLimited: boolean;
  totalFiles: number;
  truncated: boolean;
}): string | undefined {
  // scanLimited currently implies candidatesTruncated (the service reports it
  // only when the unprefiltered scan hit the candidate cap); it stays in the
  // gate as defence-in-depth because the contract types the flags independently.
  if (!(args.truncated || args.candidatesTruncated || args.scanLimited)) {
    return;
  }

  const nextOffset =
    args.filesShown === 0 && args.hasPagedFiles ? args.offset + 1 : args.offset + args.filesShown;
  // Paging only helps while unshown files remain; otherwise a "Continue with
  // offset" would send the model to a guaranteed-empty page.
  if (nextOffset <= args.offset || nextOffset >= args.totalFiles) {
    return buildRefinementHint({
      scanLimited: args.scanLimited,
      suggestContentMode: args.filesShown > 0,
    });
  }

  return (
    `Showing ${args.filesShown} of ${args.totalFiles} matching files. ` +
    `Continue with offset: ${nextOffset}, or call again with outputMode: 'content' and ` +
    'filePaths set to the most relevant paths to see the matching lines.'
  );
}

function buildFilesResult(
  mergedResult: MergedGrepResult,
  offset: number,
  topology: OpenRootTopology
): GrepFilesToolResult {
  const allFiles = aggregateFileSummaries(mergedResult.matches);
  const pagedFiles = allFiles.slice(offset);

  // The hint is part of the fitted candidate so it can never push the final
  // result back over the budget.
  const { result } = fitItemsToCharBudget(pagedFiles, (files): GrepFilesToolResult => {
    // Truncated when files were dropped (by paging or budget fitting) or the
    // service hit its internal match cap (per-file counts may be incomplete).
    const truncated = files.length + offset < allFiles.length || mergedResult.truncated;
    const hint = buildFilesHint({
      candidatesTruncated: mergedResult.candidatesTruncated,
      filesShown: files.length,
      hasPagedFiles: pagedFiles.length > 0,
      offset,
      scanLimited: mergedResult.scanLimited,
      totalFiles: allFiles.length,
      truncated,
    });
    return {
      candidatesTruncated: mergedResult.candidatesTruncated,
      files,
      liveEngine: mergedResult.liveEngine,
      offset,
      outputMode: 'files',
      scanLimited: mergedResult.scanLimited,
      totalFiles: allFiles.length,
      totalMatches: mergedResult.totalMatches,
      truncated,
      ...topology,
      ...(mergedResult.liveNote ? { liveNote: mergedResult.liveNote } : {}),
      ...(mergedResult.probeNote ? { probeNote: mergedResult.probeNote } : {}),
      ...(hint ? { hint } : {}),
    };
  });
  return result;
}

function buildContentHint(args: {
  mergedResult: MergedGrepResult;
  offset: number;
  shownCount: number;
  hadPageItems: boolean;
  serviceCap: number;
  contextLines: number;
}): string | undefined {
  const { mergedResult, offset, shownCount, hadPageItems, serviceCap, contextLines } = args;
  const morePagedMatches = offset + shownCount < mergedResult.totalMatches;
  if (!morePagedMatches) {
    // Every reachable match is shown, but the candidate pool, bounded scan, or
    // a match cap (index cap, live candidate/walk caps — live-capped matches
    // are unreached on disk and never counted in totalMatches) may still have
    // hidden others — those limits need guidance too (BST-951).
    // (scanLimited implies candidatesTruncated today; kept for defence-in-depth.)
    if (mergedResult.truncated || mergedResult.candidatesTruncated || mergedResult.scanLimited) {
      return buildRefinementHint({
        scanLimited: mergedResult.scanLimited,
        suggestContentMode: false,
      });
    }
    return;
  }
  // A single match (long line × contextLines) can exceed the whole budget; a
  // hint repeating the same offset would loop the model. Skip past it. The
  // contextLines advice appears only when context was actually requested —
  // advising "contextLines: 0" to a caller already at 0 is noise (BST-1193).
  if (shownCount === 0 && hadPageItems) {
    const contextAdvice = contextLines > 0 ? ' and contextLines: 0' : '';
    return (
      `The match at offset ${offset} is too large to display within the output budget ` +
      `(very long line). Continue with offset: ${offset + 1}${contextAdvice}, or scope with filePaths.`
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
  const contextAdvice =
    contextLines > 0 ? ', or set contextLines: 0 to fit more matches per call' : '';
  return (
    `Showing matches ${offset + 1}-${nextOffset} of ${mergedResult.totalMatches}. ` +
    `Continue with offset: ${nextOffset}, scope with filePaths${contextAdvice}.`
  );
}

function buildContentResult(args: {
  mergedResult: MergedGrepResult;
  offset: number;
  requestedMatches: number;
  serviceCap: number;
  topology: OpenRootTopology;
  contextLines: number;
}): GrepContentToolResult {
  const { mergedResult, offset, requestedMatches, serviceCap, topology, contextLines } = args;
  // Strip the internal chunk-locator fields BEFORE budget-fitting so the token
  // budget reflects the trimmed model-facing shape (and never spends budget on
  // fields the model never reads).
  const pagedMatches = mergedResult.matches
    .slice(offset, offset + requestedMatches)
    .map(toModelFacingMatch);

  const { result } = fitItemsToCharBudget(pagedMatches, (matches): GrepContentToolResult => {
    // Truncated when matches were dropped (by paging or budget fitting) or
    // either pass hit its own cap — same formula as files mode; the modes
    // must not diverge (BST-951).
    const truncated = offset + matches.length < mergedResult.totalMatches || mergedResult.truncated;
    const hint = buildContentHint({
      contextLines,
      hadPageItems: pagedMatches.length > 0,
      mergedResult,
      offset,
      serviceCap,
      shownCount: matches.length,
    });
    return {
      candidatesTruncated: mergedResult.candidatesTruncated,
      liveEngine: mergedResult.liveEngine,
      matches,
      offset,
      outputMode: 'content',
      scanLimited: mergedResult.scanLimited,
      skippedMissingLineMetadata: mergedResult.skippedMissingLineMetadata,
      totalMatches: mergedResult.totalMatches,
      truncated,
      ...topology,
      ...(mergedResult.liveNote ? { liveNote: mergedResult.liveNote } : {}),
      ...(mergedResult.probeNote ? { probeNote: mergedResult.probeNote } : {}),
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
        caseSensitive: args.caseSensitive,
        contextLines: args.contextLines,
        isRegex: args.isRegex,
        pattern: args.pattern,
        roots: args.roots,
        ...(args.filePaths === undefined ? {} : { filePaths: args.filePaths }),
      },
      args.matcher
    );
  } catch (error) {
    logger.error('live grep pass threw unexpectedly; returning index-only results', { error });
    return {
      candidatesTruncated: false,
      engine: 'skipped',
      matches: [],
      note: 'The live (on-disk) pass could not run this call, so results reflect the index only (which may be stale after recent edits).',
      scanLimited: false,
      truncated: false,
    };
  }
}

/** Run the INDEXED (PGlite trigram) search — unchanged behaviour, extracted for clarity. */
function runIndexSearch(args: {
  index: GrepIndexSearch;
  input: GrepSearchInput;
  contextLines: number;
  /** BST-764: the normalized allowlist — NOT `input.filePaths`. Both passes take this same list. */
  filePaths: readonly string[] | undefined;
  serviceMaxResults: number;
  rootId: string | undefined;
  /** Roots the absolute filePaths entries resolved to; pins the index pass to them. */
  rootIds?: readonly string[];
}): Promise<GrepSearchResult> {
  const { input } = args;
  return args.index({
    pattern: input.pattern,
    ...(input.isRegex === undefined ? {} : { isRegex: input.isRegex }),
    ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
    ...(args.filePaths === undefined ? {} : { filePaths: [...args.filePaths] }),
    contextLines: args.contextLines,
    maxResults: args.serviceMaxResults,
    ...(args.rootId === undefined ? {} : { rootId: args.rootId }),
    ...(args.rootIds === undefined ? {} : { rootIds: args.rootIds }),
  });
}

/** Run an index-only, context-free steering probe without exposing match text. */
async function runProbeIndexSearch(args: {
  index: GrepIndexSearch;
  signal: AbortSignal;
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  filePaths: readonly string[] | undefined;
  rootId: string | undefined;
  rootIds?: readonly string[];
}): Promise<ZeroMatchProbeCount> {
  // PGlite exposes no native cancellation hook here; only avoid a call that has
  // already lost its probe budget rather than pretending to cancel mid-query.
  if (args.signal.aborted) {
    return { matchCount: 0 };
  }
  const result = await args.index({
    candidateLimit: PROBE_INDEX_CANDIDATE_LIMIT,
    caseSensitive: args.caseSensitive,
    contextLines: 0,
    isRegex: args.isRegex,
    maxResults: PROBE_INDEX_MAX_RESULTS,
    pattern: args.pattern,
    ...(args.filePaths === undefined ? {} : { filePaths: args.filePaths }),
    ...(args.rootId === undefined ? {} : { rootId: args.rootId }),
    ...(args.rootIds === undefined ? {} : { rootIds: args.rootIds }),
  });
  return { matchCount: result.totalMatches };
}

/**
 * The index attributes each hit to its root id only; the label is the display
 * name of that root among the run's open roots, the same names the live pass
 * and the root topology use.
 */
function labelIndexMatchRoots(
  result: GrepSearchResult,
  runtimeData: RuntimeData | undefined
): GrepSearchResult {
  const names = new Map(
    (runtimeData?.workspaceRoots ?? []).map((root) => [root.rootId, root.displayName] as const)
  );
  return {
    ...result,
    matches: result.matches.map((match) => {
      const rootName = match.rootId ? names.get(match.rootId) : undefined;
      return rootName === undefined ? match : { ...match, rootName };
    }),
  };
}

/**
 * The folders and files a grep reads, from its resolved scope.
 *
 * BST-764: the `filePaths` allowlist is resolved ONCE, here, and both passes
 * take the same normalized list. Previously the raw model input went to both
 * and only the live pass touched it — with `p.replace(/^\/+/, '')`, which
 * turned an absolute path into a never-matching relative one and reported a
 * clean zero-match for a file that plainly matched. The refusal names only
 * paths the model supplied and the open folders it can already see, so it is a
 * `ToolInputError`: the execution guard returns it verbatim, where a plain
 * Error became its generic failure (BST-1985).
 *
 * `rootIds` pins both passes. Review follow-up on #2087: an absolute entry
 * names ONE file in ONE root, so both passes stay pinned to that root; without
 * this, flattening `/work/A/proof.html` to `proof.html` let a sibling root's
 * `proof.html` match a call that named a file in A. Without such an entry, a
 * bound thread's search names its folders (BST-1990): the index answers for
 * every folder it authorizes unless told which, and a folder outside the
 * thread must not be searched.
 */
function resolveGrepTargets(
  scope: WorkspaceSearchScope,
  requestedFilePaths: GrepSearchInput['filePaths']
): {
  readonly filePaths: readonly string[] | undefined;
  readonly liveRoots: RuntimeWorkspaceRoot[];
  readonly rootId: string | undefined;
  readonly rootIds: readonly string[] | undefined;
} {
  const scopedRoot = scope.kind === 'folder' ? scope.root : undefined;
  const roots = scope.kind === 'folder' ? [scope.root] : scope.roots;
  const resolved = resolveGrepFilePaths({ filePaths: requestedFilePaths, roots, scopedRoot });
  if (!resolved.ok) {
    throw new ToolInputError(resolved.message);
  }
  const rootIds =
    resolved.rootIds ??
    (scope.kind === 'thread' ? scope.roots.map((root) => root.rootId) : undefined);
  return {
    filePaths: resolved.filePaths,
    liveRoots:
      rootIds === undefined ? roots : roots.filter((root) => rootIds.includes(root.rootId)),
    rootId: scopedRoot?.rootId,
    rootIds,
  };
}

export async function runGrepSearchWith(
  input: GrepSearchInput,
  runtimeData: RuntimeData | undefined,
  index: GrepIndexSearch
): Promise<GrepToolResult> {
  // An explicit `root` scopes the search to that folder; without one it covers
  // every folder of the thread (BST-1990, D3). Resolve it BEFORE the try/catch
  // so an unknown or ambiguous folder reaches the model as its typed refusal
  // instead of the generic catch.
  const scope = resolveWorkspaceSearchScope(runtimeData, input.root);

  const outputMode = input.outputMode ?? 'files';
  const offset = input.offset ?? 0;
  const requestedMatches = input.maxResults ?? DEFAULT_CONTENT_MATCHES;
  // Both modes request the same internal cap: the page size bounds what is
  // RETURNED, never what the index pass materializes for the merge.
  const serviceMaxResults = INTERNAL_MATCH_CAP;

  const isRegex = input.isRegex ?? false;
  const caseSensitive = input.caseSensitive ?? false;
  // Context defaults to 0 (BST-1193): searches locate, reads understand.
  // Every studied peer ships no context by default; the option remains for
  // deliberate opt-in.
  const contextLines = outputMode === 'files' ? 0 : (input.contextLines ?? 0);
  // Build the authoritative matcher up front: an invalid regex throws here
  // (BEFORE any DB or disk work), preserving the no-coercion contract, and the
  // SAME matcher instance drives the live pass so live + indexed match
  // semantics can never diverge.
  const liveMatcher = createModelPatternMatcher(input.pattern, isRegex, caseSensitive);
  const { filePaths, liveRoots, rootId, rootIds } = resolveGrepTargets(scope, input.filePaths);

  try {
    const serviceResult = labelIndexMatchRoots(
      await runIndexSearch({
        contextLines,
        filePaths,
        input,
        rootId,
        ...(rootIds === undefined ? {} : { rootIds }),
        index,
        serviceMaxResults,
      }),
      runtimeData
    );

    const liveResult = await runLiveGrepSafely({
      caseSensitive,
      contextLines,
      isRegex,
      pattern: input.pattern,
      roots: liveRoots,
      ...(filePaths === undefined ? {} : { filePaths }),
      matcher: liveMatcher,
    });

    const merged = mergeGrepMatches(serviceResult, liveResult);
    const probeNote =
      merged.matches.length === 0
        ? await resolveZeroMatchProbeNote(
            { caseSensitive, isRegex },
            {
              runCaseProbe: (signal) =>
                runProbeIndexSearch({
                  caseSensitive: false,
                  filePaths,
                  isRegex,
                  pattern: input.pattern,
                  rootId,
                  signal,
                  ...(rootIds === undefined ? {} : { rootIds }),
                  index,
                }),
              runExcludedPathProbe: (signal) =>
                probeExcludedPathMatches(
                  {
                    caseSensitive,
                    isRegex,
                    pattern: input.pattern,
                    roots: liveRoots,
                    ...(filePaths === undefined ? {} : { filePaths }),
                  },
                  liveMatcher,
                  signal
                ),
              runLiteralProbe: (signal) =>
                runProbeIndexSearch({
                  caseSensitive,
                  filePaths,
                  isRegex: false,
                  pattern: input.pattern,
                  rootId,
                  signal,
                  ...(rootIds === undefined ? {} : { rootIds }),
                  index,
                }),
            }
          )
        : undefined;
    const mergedWithProbe: MergedGrepResult = {
      ...merged,
      ...(probeNote ? { probeNote } : {}),
    };

    // The projection prefixes file headers with root names only when several
    // folders are OPEN (not merely matched), so the open-root topology —
    // count plus globally ambiguous display names — rides the result
    // envelope; single-root stays absent and unprefixed (BST-1185).
    const topology = describeOpenRootTopology(runtimeData);

    return parseGrepToolResult(
      outputMode === 'files'
        ? buildFilesResult(mergedWithProbe, offset, topology)
        : buildContentResult({
            contextLines,
            mergedResult: mergedWithProbe,
            offset,
            requestedMatches,
            serviceCap: INTERNAL_MATCH_CAP,
            topology,
          })
    );
  } catch (error) {
    // A deliberate refusal is typed, never recognized by its text: an input
    // error or a boundary refusal (the index's fixed, sanitized reason, which
    // the tool guard shows the model) passes through, and everything else (raw
    // PGlite/SQL errors, host paths, faults) stays behind a generic message and
    // the log (BST-1985).
    if (error instanceof ToolInputError || isBoundaryRefusal(error)) {
      throw error;
    }
    logger.error('grepSearch failed', { error, pattern: REDACTED_GREP_PATTERN_LOG_VALUE });
    throw new Error('Unable to perform grep search right now. Try again.');
  }
}

/**
 * The line matcher refuses only the model's own pattern (the ReDoS guard or a
 * `RegExp` that does not compile), so each refusal is the model's to correct.
 */
function createModelPatternMatcher(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean
): LineMatcher {
  try {
    return createGrepLineMatcher(pattern, isRegex, caseSensitive);
  } catch (error) {
    throw new ToolInputError(error instanceof Error ? error.message : String(error));
  }
}
