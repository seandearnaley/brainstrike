import {
  fitItemsToCharBudget,
  type GrepSearchInput,
  type RuntimeData,
  type RuntimeWorkspaceRoot,
} from '@brainstrike/agent';
import type { GrepMatch } from '@brainstrike/assistant-contract';
import { ToolInputError } from '@brainstrike/assistant-contract';
import {
  describeOpenRootTopology,
  type OpenRootTopology,
  resolveWorkspaceSearchScope,
  type WorkspaceSearchScope,
} from '@brainstrike/assistant-service/node-workspace-services';
import { createLogger } from '@brainstrike/logging';
import { createGrepLineMatcher, type LineMatcher } from '@brainstrike/utils/grep-line-matcher';
import { resolveGrepFilePaths } from './grep-file-paths.ts';
import {
  type GrepContentToolResult,
  type GrepFileSummary,
  type GrepFilesToolResult,
  type GrepToolResult,
  parseGrepToolResult,
} from './grep-search-result-contract.ts';
import { resolveZeroMatchProbeNote, type ZeroMatchProbeCount } from './grep-zero-match-probes.ts';
import { type LiveGrepResult, probeExcludedPathMatches, runLiveGrep } from './live-grep.ts';

const logger = createLogger('AssistantGrepSearchTool');

const DEFAULT_CONTENT_MATCHES = 50;
const REDACTED_GREP_PATTERN_LOG_VALUE = { redacted: true } as const;

/**
 * The on-disk pass's matches, sorted, with its substrate flags and the
 * zero-match steering note. Grep is the core lane (ADR 0026): it reads the
 * thread's folders on disk and never asks Main's index.
 */
interface GrepPassResult {
  candidatesTruncated: boolean;
  liveEngine: LiveGrepResult['engine'];
  liveNote?: string;
  matches: GrepMatch[];
  probeNote?: string;
  scanLimited: boolean;
  totalMatches: number;
}

/**
 * The live pass reads every candidate file in full, so its matches are the
 * complete set it reached and `totalMatches` counts exactly them. Its caps are
 * substrate conditions: they stay in `candidatesTruncated`/`scanLimited`, never
 * in the output-only `truncated` (BST-1247).
 */
function toGrepPassResult(live: LiveGrepResult): GrepPassResult {
  const matches = [...live.matches].sort(
    (a, b) =>
      (a.rootName ?? '').localeCompare(b.rootName ?? '') ||
      a.path.localeCompare(b.path) ||
      a.line - b.line
  );
  return {
    candidatesTruncated: live.candidatesTruncated,
    liveEngine: live.engine,
    matches,
    scanLimited: live.scanLimited,
    totalMatches: matches.length,
    ...(live.note ? { liveNote: live.note } : {}),
  };
}

function aggregateFileSummaries(matches: readonly GrepMatch[]): GrepFileSummary[] {
  // Key by (root, path): two open roots can share a relative path, and keying
  // on path alone would merge their counts into one bogus summary.
  const byKey = new Map<string, GrepFileSummary>();
  for (const match of matches) {
    const key = `${match.rootId ?? ''}\u0000${match.path}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.matchCount += 1;
      existing.firstLine = Math.min(existing.firstLine, match.line);
    } else {
      byKey.set(key, {
        firstLine: match.line,
        matchCount: 1,
        path: match.path,
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
    ? ' The regex had no long guaranteed literal for the ripgrep prefilter — rewrite it to include a ≥3-character literal, or split alternations into separate searches, to cover more of the workspace.'
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
  found: GrepPassResult,
  offset: number,
  topology: OpenRootTopology
): GrepFilesToolResult {
  const allFiles = aggregateFileSummaries(found.matches);
  const pagedFiles = allFiles.slice(offset);

  // The hint is part of the fitted candidate so it can never push the final
  // result back over the budget.
  const { result } = fitItemsToCharBudget(pagedFiles, (files): GrepFilesToolResult => {
    // Truncated when files were dropped by paging or budget fitting.
    const truncated = files.length + offset < allFiles.length;
    const hint = buildFilesHint({
      candidatesTruncated: found.candidatesTruncated,
      filesShown: files.length,
      hasPagedFiles: pagedFiles.length > 0,
      offset,
      scanLimited: found.scanLimited,
      totalFiles: allFiles.length,
      truncated,
    });
    return {
      candidatesTruncated: found.candidatesTruncated,
      files,
      liveEngine: found.liveEngine,
      offset,
      outputMode: 'files',
      scanLimited: found.scanLimited,
      totalFiles: allFiles.length,
      totalMatches: found.totalMatches,
      truncated,
      ...topology,
      ...(found.liveNote ? { liveNote: found.liveNote } : {}),
      ...(found.probeNote ? { probeNote: found.probeNote } : {}),
      ...(hint ? { hint } : {}),
    };
  });
  return result;
}

function buildContentHint(args: {
  found: GrepPassResult;
  offset: number;
  shownCount: number;
  hadPageItems: boolean;
  contextLines: number;
}): string | undefined {
  const { found, offset, shownCount, hadPageItems, contextLines } = args;
  const morePagedMatches = offset + shownCount < found.totalMatches;
  if (!morePagedMatches) {
    // Every reachable match is shown, but the candidate pool or bounded scan
    // (live-capped matches are unreached on disk and never counted in
    // totalMatches) may still have hidden others — those limits need guidance
    // too (BST-951).
    // (scanLimited implies candidatesTruncated today; kept for defence-in-depth.)
    if (found.candidatesTruncated || found.scanLimited) {
      return buildRefinementHint({
        scanLimited: found.scanLimited,
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
  const contextAdvice =
    contextLines > 0 ? ', or set contextLines: 0 to fit more matches per call' : '';
  return (
    `Showing matches ${offset + 1}-${nextOffset} of ${found.totalMatches}. ` +
    `Continue with offset: ${nextOffset}, scope with filePaths${contextAdvice}.`
  );
}

function buildContentResult(args: {
  found: GrepPassResult;
  offset: number;
  requestedMatches: number;
  topology: OpenRootTopology;
  contextLines: number;
}): GrepContentToolResult {
  const { found, offset, requestedMatches, topology, contextLines } = args;
  const pagedMatches = found.matches.slice(offset, offset + requestedMatches);

  const { result } = fitItemsToCharBudget(pagedMatches, (matches): GrepContentToolResult => {
    // Truncated when matches were dropped by paging or budget fitting — same
    // formula as files mode; the modes must not diverge (BST-951).
    const truncated = offset + matches.length < found.totalMatches;
    const hint = buildContentHint({
      contextLines,
      found,
      hadPageItems: pagedMatches.length > 0,
      offset,
      shownCount: matches.length,
    });
    return {
      candidatesTruncated: found.candidatesTruncated,
      liveEngine: found.liveEngine,
      matches,
      offset,
      outputMode: 'content',
      scanLimited: found.scanLimited,
      totalMatches: found.totalMatches,
      truncated,
      ...topology,
      ...(found.liveNote ? { liveNote: found.liveNote } : {}),
      ...(found.probeNote ? { probeNote: found.probeNote } : {}),
      ...(hint ? { hint } : {}),
    };
  });
  return result;
}

/**
 * A count-only zero-match steering probe: the same on-disk pass with one
 * matcher setting changed (case-insensitive, or the pattern as a literal),
 * never exposing match text. The probe budget's abort ends the pass and its
 * ripgrep mid-scan.
 */
async function countLiveMatches(args: {
  caseSensitive: boolean;
  filePaths: readonly string[] | undefined;
  isRegex: boolean;
  pattern: string;
  roots: readonly RuntimeWorkspaceRoot[];
  signal: AbortSignal;
}): Promise<ZeroMatchProbeCount> {
  if (args.signal.aborted) {
    return { matchCount: 0 };
  }
  const result = await runLiveGrep(
    {
      caseSensitive: args.caseSensitive,
      contextLines: 0,
      isRegex: args.isRegex,
      pattern: args.pattern,
      roots: args.roots,
      signal: args.signal,
      ...(args.filePaths === undefined ? {} : { filePaths: args.filePaths }),
    },
    createModelPatternMatcher(args.pattern, args.isRegex, args.caseSensitive)
  );
  return { matchCount: result.matches.length };
}

/**
 * The folders and files a grep reads, from its resolved scope.
 *
 * BST-764: the `filePaths` allowlist is resolved ONCE, here, so the search and
 * its probes take the same normalized list. The raw model input once reached
 * the live pass through `p.replace(/^\/+/, '')`, which turned an absolute path
 * into a never-matching relative one and reported a clean zero-match for a file
 * that plainly matched. The refusal names only paths the model supplied and the
 * open folders it can already see, so it is a `ToolInputError`: the execution
 * guard returns it verbatim, where a plain Error became its generic failure
 * (BST-1985).
 *
 * An absolute entry names ONE file in ONE root, so the search stays pinned to
 * that root; without this, flattening `/work/A/proof.html` to `proof.html` let a
 * sibling root's `proof.html` match a call that named a file in A (review
 * follow-up on #2087). Without such an entry, a bound thread searches its own
 * folders and no other (BST-1990).
 */
function resolveGrepTargets(
  scope: WorkspaceSearchScope,
  requestedFilePaths: GrepSearchInput['filePaths']
): {
  readonly filePaths: readonly string[] | undefined;
  readonly roots: RuntimeWorkspaceRoot[];
} {
  const scopedRoot = scope.kind === 'folder' ? scope.root : undefined;
  const roots = scope.kind === 'folder' ? [scope.root] : scope.roots;
  const resolved = resolveGrepFilePaths({ filePaths: requestedFilePaths, roots, scopedRoot });
  if (!resolved.ok) {
    throw new ToolInputError(resolved.message);
  }
  const pinned = resolved.rootIds;
  return {
    filePaths: resolved.filePaths,
    roots: pinned === undefined ? roots : roots.filter((root) => pinned.includes(root.rootId)),
  };
}

export async function runGrepSearchWith(
  input: GrepSearchInput,
  runtimeData: RuntimeData | undefined
): Promise<GrepToolResult> {
  // An explicit `root` scopes the search to that folder; without one it covers
  // every folder of the thread (BST-1990, D3). Resolve it BEFORE the try/catch
  // so an unknown or ambiguous folder reaches the model as its typed refusal
  // instead of the generic catch.
  const scope = resolveWorkspaceSearchScope(runtimeData, input.root);

  const outputMode = input.outputMode ?? 'files';
  const offset = input.offset ?? 0;
  const requestedMatches = input.maxResults ?? DEFAULT_CONTENT_MATCHES;
  const isRegex = input.isRegex ?? false;
  const caseSensitive = input.caseSensitive ?? false;
  // Context defaults to 0 (BST-1193): searches locate, reads understand.
  // Every studied peer ships no context by default; the option remains for
  // deliberate opt-in.
  const contextLines = outputMode === 'files' ? 0 : (input.contextLines ?? 0);
  // Build the authoritative matcher up front: an invalid regex throws here,
  // before any disk work, preserving the no-coercion contract.
  const matcher = createModelPatternMatcher(input.pattern, isRegex, caseSensitive);
  const { filePaths, roots } = resolveGrepTargets(scope, input.filePaths);
  const scoped = filePaths === undefined ? {} : { filePaths };

  try {
    const pass = toGrepPassResult(
      await runLiveGrep(
        { caseSensitive, contextLines, isRegex, pattern: input.pattern, roots, ...scoped },
        matcher
      )
    );
    const probeNote =
      pass.matches.length === 0
        ? await resolveZeroMatchProbeNote(
            { caseSensitive, isRegex },
            {
              runCaseProbe: (signal) =>
                countLiveMatches({
                  caseSensitive: false,
                  filePaths,
                  isRegex,
                  pattern: input.pattern,
                  roots,
                  signal,
                }),
              runExcludedPathProbe: (signal) =>
                probeExcludedPathMatches(
                  { caseSensitive, isRegex, pattern: input.pattern, roots, ...scoped },
                  matcher,
                  signal
                ),
              runLiteralProbe: (signal) =>
                countLiveMatches({
                  caseSensitive,
                  filePaths,
                  isRegex: false,
                  pattern: input.pattern,
                  roots,
                  signal,
                }),
            }
          )
        : undefined;
    const result: GrepPassResult = { ...pass, ...(probeNote ? { probeNote } : {}) };

    // The projection prefixes file headers with root names only when several
    // folders are OPEN (not merely matched), so the open-root topology —
    // count plus globally ambiguous display names — rides the result
    // envelope; single-root stays absent and unprefixed (BST-1185).
    const topology = describeOpenRootTopology(runtimeData);

    return parseGrepToolResult(
      outputMode === 'files'
        ? buildFilesResult(result, offset, topology)
        : buildContentResult({
            contextLines,
            found: result,
            offset,
            requestedMatches,
            topology,
          })
    );
  } catch (error) {
    // A deliberate refusal is typed, never recognized by its text: the model's
    // own input error passes through, and everything else (filesystem errors
    // carrying host paths, faults) stays behind a generic message and the log
    // (BST-1985).
    if (error instanceof ToolInputError) {
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
