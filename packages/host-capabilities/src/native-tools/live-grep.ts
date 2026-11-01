import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import type { GrepMatch } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { createBackgroundIndexingEntryPolicy } from '@brainstrike/utils';
import type { LineMatcher } from '@brainstrike/utils/grep-line-matcher';
import { createAgentIgnoreGuard } from './agent-ignore-guard.ts';
import { collectGrepMatchesInContent } from './grep-search.ts';
import { resolveScopedGrepFile } from './live-grep-files.ts';
import { buildLiveNote } from './live-grep-note.ts';
import {
  bundledRipgrepPath,
  PROBE_RIPGREP_TIMEOUT_MS,
  RipgrepRunError,
  resolveRipgrepPrefilterLiteral,
  runRipgrep,
  streamRipgrep,
} from './live-grep-ripgrep.ts';
import { isWithinRoot } from './workspace-path.ts';

const logger = createLogger('AssistantLiveGrep');

/**
 * `execFile`'s ChildProcessError embeds the full spawned command (including the
 * grep pattern) in `.message`/`.cmd`, and fs errors embed the real workspace
 * path in `.message`/`.path` — neither is safe to log verbatim (mirrors
 * `redactToolErrorForLog` in assistant-tools.ts).
 */
function redactErrorForLog(error: unknown): {
  code?: string | number;
  name: string;
  redacted: true;
} {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return {
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    name: error instanceof Error && error.name.length > 0 ? error.name : typeof error,
    redacted: true,
  };
}

/** Default hard cap on candidate files materialized from the live pass (per call, all roots). */
const DEFAULT_MAX_LIVE_CANDIDATE_FILES = 1500;
/** Maximum excluded files read by one count-only steering probe, per root. */
const PROBE_EXCLUDED_PATH_MAX_CANDIDATE_FILES = 200;
/** Active candidate cap; overridable in tests so the cap path is exercised without 1500+ files. */
let maxLiveCandidateFiles = DEFAULT_MAX_LIVE_CANDIDATE_FILES;
/** Skip on-disk files larger than this when reading them for the authoritative match. */
const MAX_READ_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Test-only: override the live candidate cap (pass nothing to restore the
 * default). Lets a unit test prove the resolve loop stops at the cap and
 * surfaces `truncated` without materializing thousands of real files.
 * @internal Live grep regressions force deterministic candidate limits.
 */
export function setMaxLiveCandidateFilesForTests(value?: number): void {
  maxLiveCandidateFiles = value ?? DEFAULT_MAX_LIVE_CANDIDATE_FILES;
}

/** How a live search ended: its caps and engine, never silent. */
export interface LiveGrepOutcome {
  /**
   * BST-1247 substrate cap (rg output cap or the global candidate cap),
   * separate so `truncated` can stay output-only downstream.
   */
  candidatesTruncated: boolean;
  /**
   * The engine that produced the candidate file set:
   * - 'ripgrep'  — the bundled `rg` streamed the candidates.
   * - 'js-files' — the exact requested files were resolved directly.
   * - 'skipped'  — the live pass could not run at all (e.g. no readable roots).
   */
  engine: 'ripgrep' | 'js-files' | 'skipped';
  /**
   * Non-silent note when the search hit a cap, ran out of time or could not
   * read a folder. Undefined on the clean path.
   */
  note?: string;
  /**
   * A regex with no literal ripgrep could prefilter on listed every eligible
   * file, and that unprefiltered scan stopped at the candidate cap.
   */
  scanLimited: boolean;
  /** ripgrep reached its time budget on some root; what it found was kept. */
  timedOut: boolean;
  /** True when any live cap was hit (more may exist, unreached). */
  truncated: boolean;
  /** Roots whose folder could not be opened, so they were not searched. */
  unreadableRoots: readonly RuntimeWorkspaceRoot[];
}

/** The live search's outcome with every match it found, collected. */
export interface LiveGrepResult extends LiveGrepOutcome {
  /** Authoritative matches found fresh on disk. */
  matches: GrepMatch[];
}

/** A live candidate file to read + match, labelled with its owning root. */
interface LiveCandidate {
  absolutePath: string;
  relativePath: string;
  rootId: string;
  rootName: string;
}

function hasDotGitSegment(relativePath: string): boolean {
  // resolveCandidate runs once per live grep candidate; scan in place to avoid
  // allocating a segment array for every path just to reject `.git`.
  let segmentStart = 0;
  while (segmentStart < relativePath.length) {
    const slashIndex = relativePath.indexOf('/', segmentStart);
    const segmentEnd = slashIndex === -1 ? relativePath.length : slashIndex;
    if (
      segmentEnd - segmentStart === 4 &&
      relativePath.charCodeAt(segmentStart) === 46 &&
      relativePath.charCodeAt(segmentStart + 1) === 103 &&
      relativePath.charCodeAt(segmentStart + 2) === 105 &&
      relativePath.charCodeAt(segmentStart + 3) === 116
    ) {
      return true;
    }
    if (slashIndex === -1) {
      return false;
    }
    segmentStart = slashIndex + 1;
  }
  return false;
}

type IndexingEntryPolicy = ReturnType<typeof createBackgroundIndexingEntryPolicy>;

/**
 * Keep a ripgrep candidate only when (a) the balanced entry policy keeps it (so
 * the live pass excludes exactly what glob excludes — single source of truth,
 * not rg's `.gitignore`) and (b) its realpath stays inside the canonical root
 * (symlink-escape defence, mirroring glob).
 */
async function resolveCandidate(args: {
  relativePath: string;
  canonicalRootPath: string;
  root: RuntimeWorkspaceRoot;
  policy: IndexingEntryPolicy;
}): Promise<LiveCandidate | null> {
  const fileName = path.posix.basename(args.relativePath);
  if (
    !args.policy.shouldIncludeFile({
      fileName,
      fileSize: undefined,
      relativePath: args.relativePath,
    })
  ) {
    return null;
  }
  // .git is never a useful source root; rg already ignores it, but re-assert.
  if (hasDotGitSegment(args.relativePath)) {
    return null;
  }
  const absolute = path.join(args.canonicalRootPath, args.relativePath);
  let canonical: string;
  let stat: import('node:fs').Stats;
  try {
    canonical = await fsPromises.realpath(absolute);
    stat = await fsPromises.stat(absolute);
  } catch {
    return null;
  }
  if (!(isWithinRoot(args.canonicalRootPath, canonical) && stat.isFile())) {
    return null;
  }
  return {
    absolutePath: canonical,
    relativePath: args.relativePath,
    rootId: args.root.rootId,
    rootName: args.root.displayName,
  };
}

/** Read a candidate file (size-bounded) and run the authoritative matcher over it. */
async function matchCandidate(
  candidate: LiveCandidate,
  matcher: LineMatcher,
  contextLines: number,
  exactScope = false
): Promise<GrepMatch[]> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fsPromises.stat(candidate.absolutePath);
  } catch (error) {
    if (exactScope && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return [];
  }
  if (stat.size > MAX_READ_FILE_BYTES) {
    if (exactScope) {
      throw new Error('A selected live grep file exceeds the bounded read size.');
    }
    return [];
  }
  let content: string;
  try {
    content = await fsPromises.readFile(candidate.absolutePath, 'utf8');
  } catch (error) {
    if (exactScope && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    logger.debug('live grep: unreadable candidate skipped', {
      error,
      path: candidate.relativePath,
    });
    return [];
  }
  return collectGrepMatchesInContent({
    content,
    contextLines,
    matcher,
    // Root-relative, without a leading slash.
    path: candidate.relativePath,
    rootId: candidate.rootId,
    rootName: candidate.rootName,
    startLine: 1,
  });
}

export interface LiveGrepOptions {
  caseSensitive: boolean;
  contextLines: number;
  /** Optional exact-path allowlist (workspace-relative, no leading slash). */
  filePaths?: readonly string[];
  isRegex: boolean;
  pattern: string;
  roots: readonly RuntimeWorkspaceRoot[];
  /** Ends the search: ripgrep is killed and no further match is emitted. */
  signal?: AbortSignal | undefined;
}

export interface ExcludedPathProbeOptions {
  caseSensitive: boolean;
  filePaths?: readonly string[];
  isRegex: boolean;
  pattern: string;
  roots: readonly RuntimeWorkspaceRoot[];
}

interface ExcludedPathProbeRootResult {
  examplePaths?: readonly string[];
  matchCount: number;
  /**
   * BST-1246 review: the probe's bounded rg run hit its time budget for this
   * root, so a zero count is "did not finish", NOT "no matches". Surfaced to
   * the zero-match note builder — a silent zero here would be exactly the
   * silent-degradation pattern this ticket removes, relocated to the probe.
   */
  timedOut?: boolean;
}

function mergeExcludedPathProbeResults(
  results: readonly ExcludedPathProbeRootResult[]
): ExcludedPathProbeRootResult {
  let matchCount = 0;
  let timedOut = false;
  const examplePaths: string[] = [];
  for (const result of results) {
    matchCount += result.matchCount;
    timedOut = timedOut || result.timedOut === true;
    if (result.examplePaths && examplePaths.length < 2) {
      examplePaths.push(...result.examplePaths.slice(0, 2 - examplePaths.length));
    }
  }
  return {
    matchCount,
    ...(examplePaths.length === 0 ? {} : { examplePaths }),
    ...(timedOut ? { timedOut } : {}),
  };
}

function isExcludedPathProbeCandidate(args: {
  filePathAllow: ReadonlySet<string> | null;
  policy: IndexingEntryPolicy;
  relativePath: string;
}): boolean {
  if (args.filePathAllow && !args.filePathAllow.has(args.relativePath)) {
    return false;
  }
  if (hasDotGitSegment(args.relativePath)) {
    return false;
  }
  return !args.policy.shouldIncludeFile({
    fileName: path.posix.basename(args.relativePath),
    fileSize: undefined,
    relativePath: args.relativePath,
  });
}

async function countExcludedCandidateMatches(args: {
  canonicalRootPath: string;
  canonicalTarget?: string;
  matcher: LineMatcher;
  relativePath: string;
  root: RuntimeWorkspaceRoot;
  signal: AbortSignal;
}): Promise<number> {
  if (args.signal.aborted) {
    return 0;
  }
  try {
    const absolutePath =
      args.canonicalTarget ?? path.join(args.canonicalRootPath, args.relativePath);
    const canonicalTarget = args.canonicalTarget ?? (await fsPromises.realpath(absolutePath));
    const stat = await fsPromises.stat(absolutePath);
    if (
      !(isWithinRoot(args.canonicalRootPath, canonicalTarget) && stat.isFile()) ||
      stat.size > MAX_READ_FILE_BYTES
    ) {
      return 0;
    }
    const content = await fsPromises.readFile(canonicalTarget, {
      encoding: 'utf8',
      signal: args.signal,
    });
    const matches = collectGrepMatchesInContent({
      content,
      contextLines: 0,
      matcher: args.matcher,
      path: args.relativePath,
      rootId: args.root.rootId,
      rootName: args.root.displayName,
      startLine: 1,
    });
    return matches.length;
  } catch (error) {
    logger.warn('excluded-path grep probe: candidate could not be matched', {
      error: redactErrorForLog(error),
      rootId: args.root.rootId,
    });
    return 0;
  }
}

async function probeExcludedRoot(args: {
  caseSensitive: boolean;
  filePathAllow: ReadonlySet<string> | null;
  matcher: LineMatcher;
  policy: IndexingEntryPolicy;
  prefilterLiteral: string;
  ripgrepPath: string;
  root: RuntimeWorkspaceRoot;
  signal: AbortSignal;
}): Promise<ExcludedPathProbeRootResult> {
  const empty: ExcludedPathProbeRootResult = { matchCount: 0 };
  if (args.signal.aborted) {
    return empty;
  }
  let canonicalRootPath: string;
  try {
    canonicalRootPath = await fsPromises.realpath(args.root.path);
  } catch (error) {
    logger.warn('excluded-path grep probe: root is not accessible', {
      error: redactErrorForLog(error),
      rootId: args.root.rootId,
    });
    return empty;
  }

  let candidatePaths: Set<string>;
  try {
    const run = await runRipgrep({
      applyPolicyPrune: false,
      canonicalRootPath,
      caseSensitive: args.caseSensitive,
      mode: 'files-with-matches',
      prefilterLiteral: args.prefilterLiteral,
      ripgrepPath: args.ripgrepPath,
      signal: args.signal,
      timeoutMs: PROBE_RIPGREP_TIMEOUT_MS,
    });
    if (run.truncated) {
      logger.warn('excluded-path grep probe: ripgrep candidate output was truncated', {
        rootId: args.root.rootId,
      });
    }
    // BST-1246: the probe is a bounded best-effort hint (1.5s budget over
    // policy-EXCLUDED trees, node_modules included by design). Blowing that
    // budget on a big repo is the expected bounded outcome: its zero count
    // reads as unfinished, never as "no matches".
    if (run.timedOut) {
      return { matchCount: 0, timedOut: true };
    }
    candidatePaths = run.candidatePaths;
  } catch (error) {
    if (args.signal.aborted) {
      return empty;
    }
    const metadata = error instanceof RipgrepRunError ? error.metadata : undefined;
    logger.warn('excluded-path grep probe: ripgrep failed for a root', {
      error: redactErrorForLog(error),
      ...(metadata ? { ripgrep: metadata } : {}),
      rootId: args.root.rootId,
    });
    return empty;
  }

  // Spend the bounded per-root candidate budget on a fixed, known-eligible
  // slice BEFORE any filesystem read fires — a synchronous filter+slice, so
  // this never attempts more than PROBE_EXCLUDED_PATH_MAX_CANDIDATE_FILES
  // reads regardless of how many paths ripgrep reports. Every kept read
  // targets a distinct file, so the whole slice is safe to run concurrently.
  const eligible: string[] = [];
  for (const relativePath of candidatePaths) {
    if (eligible.length >= PROBE_EXCLUDED_PATH_MAX_CANDIDATE_FILES) {
      break;
    }
    if (
      isExcludedPathProbeCandidate({
        filePathAllow: args.filePathAllow,
        policy: args.policy,
        relativePath,
      })
    ) {
      eligible.push(relativePath);
    }
  }

  if (args.signal.aborted) {
    return empty;
  }
  // The probe's whole purpose is reading inside policy-EXCLUDED trees, which
  // makes it the read path most likely to steer past an agent ignore file. The
  // hard boundary is the one exclusion it may not bypass (BST-1432), so it is
  // applied to the bounded slice — after the cap, before any file is opened.
  const guard = createAgentIgnoreGuard(canonicalRootPath);
  const guardVerdicts = await Promise.all(
    eligible.map((relativePath) => guard.ignoresFile(relativePath))
  );
  const permitted = eligible.filter((_relativePath, index) => guardVerdicts[index] !== true);

  const candidateResults = await Promise.all(
    permitted.map((relativePath) =>
      countExcludedCandidateMatches({
        canonicalRootPath,
        matcher: args.matcher,
        relativePath,
        root: args.root,
        signal: args.signal,
      }).then((matchCount) => ({
        matchCount,
        ...(matchCount > 0 ? { examplePaths: [relativePath] } : {}),
      }))
    )
  );
  return mergeExcludedPathProbeResults(candidateResults);
}

async function probeScopedExcludedRoot(args: {
  root: RuntimeWorkspaceRoot;
  filePaths: readonly string[];
  matcher: LineMatcher;
  signal: AbortSignal;
}): Promise<ExcludedPathProbeRootResult> {
  const empty = { matchCount: 0 };
  if (args.signal.aborted) {
    return empty;
  }
  try {
    const canonicalRootPath = await fsPromises.realpath(args.root.path);
    const guard = createAgentIgnoreGuard(canonicalRootPath);
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'balanced' });
    const results: ExcludedPathProbeRootResult[] = [];
    let checked = 0;
    for (const relativePath of new Set(args.filePaths)) {
      if (args.signal.aborted || checked >= PROBE_EXCLUDED_PATH_MAX_CANDIDATE_FILES) {
        break;
      }
      if (!isExcludedPathProbeCandidate({ filePathAllow: null, policy, relativePath })) {
        continue;
      }
      const absolutePath = await resolveScopedGrepFile({
        canonicalRootPath,
        includeExcluded: true,
        relativePath,
      });
      if (absolutePath === null) {
        continue;
      }
      const candidate = {
        absolutePath,
        relativePath,
        rootId: args.root.rootId,
        rootName: args.root.displayName,
      };
      if ((await dropAgentIgnored(canonicalRootPath, [candidate], guard)).length === 0) {
        continue;
      }
      checked += 1;
      const matchCount = await countExcludedCandidateMatches({
        canonicalRootPath,
        canonicalTarget: absolutePath,
        matcher: args.matcher,
        relativePath,
        root: args.root,
        signal: args.signal,
      });
      results.push({ matchCount, ...(matchCount > 0 ? { examplePaths: [relativePath] } : {}) });
    }
    return args.signal.aborted ? empty : mergeExcludedPathProbeResults(results);
  } catch (error) {
    logger.warn('excluded-path grep probe: selected files could not be matched', {
      error: redactErrorForLog(error),
      rootId: args.root.rootId,
    });
    return empty;
  }
}

/**
 * Count authoritative matches only in files the balanced indexing policy would
 * exclude. Exact file scopes resolve directly; root-wide probing uses only a
 * safe ripgrep prefilter. Both are bounded more tightly than the live pass.
 * A regex with no literal is never probed root-wide.
 */
export async function probeExcludedPathMatches(
  options: ExcludedPathProbeOptions,
  matcher: LineMatcher,
  abortSignal?: AbortSignal
): Promise<{ examplePaths?: readonly string[]; matchCount: number; timedOut?: boolean }> {
  const empty = { matchCount: 0 };
  if (options.roots.length === 0) {
    return empty;
  }

  const signal = abortSignal ?? new AbortController().signal;
  if (signal.aborted) {
    return empty;
  }

  try {
    if (options.filePaths !== undefined) {
      const rootResults = await Promise.all(
        options.roots.map((root) =>
          probeScopedExcludedRoot({ filePaths: options.filePaths ?? [], matcher, root, signal })
        )
      );
      return mergeExcludedPathProbeResults(rootResults);
    }
    const prefilterLiteral = resolveRipgrepPrefilterLiteral({
      isRegex: options.isRegex,
      pattern: options.pattern,
    });
    if (prefilterLiteral === null || signal.aborted) {
      return empty;
    }
    const ripgrepPath = bundledRipgrepPath();

    const filePathAllow = null;
    const policy = createBackgroundIndexingEntryPolicy({ preset: 'balanced' });

    // Each root is a distinct filesystem tree with its own ripgrep process and
    // its own PROBE_EXCLUDED_PATH_MAX_CANDIDATE_FILES budget — the roots have
    // no shared state, so every root scans concurrently instead of waiting on
    // its predecessors. The shared signal reaches every concurrent process.
    if (signal.aborted) {
      return empty;
    }
    const rootResults = await Promise.all(
      options.roots.map((root) =>
        probeExcludedRoot({
          caseSensitive: options.caseSensitive,
          filePathAllow,
          matcher,
          policy,
          prefilterLiteral,
          ripgrepPath,
          root,
          signal,
        })
      )
    );

    return mergeExcludedPathProbeResults(rootResults);
  } catch (error) {
    // Defence in depth: this auxiliary probe must never fail grepSearch even
    // when an unexpected policy/runtime error escapes the per-root/file guards.
    logger.warn('excluded-path grep probe failed unexpectedly; treating as a miss', {
      error: redactErrorForLog(error),
    });
    return empty;
  }
}

/** Running state while a live search walks the workspace roots. */
interface LiveSearchState {
  anyRootAccessible: boolean;
  /** The search stopped at the global candidate cap (more on disk). */
  candidateCapHit: boolean;
  candidateCount: number;
  /** rg exited 2 with usable candidates: some files were unreadable (BST-1246). */
  partialReadErrors: boolean;
  prefilterTruncated: boolean;
  /** ripgrep reached its time budget on some root; its candidates were kept. */
  timedOut: boolean;
  /** Roots whose folder could not be opened; the result names them (ADR 0026). */
  unreadableRoots: RuntimeWorkspaceRoot[];
}

type MatchSink = (matches: readonly GrepMatch[]) => void;

/** Matches one permitted candidate and hands its matches on, unless the search ended. */
async function emitCandidate(args: {
  candidate: LiveCandidate;
  contextLines: number;
  exactScope: boolean;
  matcher: LineMatcher;
  onMatches: MatchSink;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const matches = await matchCandidate(
    args.candidate,
    args.matcher,
    args.contextLines,
    args.exactScope
  );
  if (matches.length > 0 && args.signal?.aborted !== true) {
    args.onMatches(matches);
  }
}

async function searchScopedRoot(args: {
  canonicalRootPath: string;
  contextLines: number;
  filePathAllow: ReadonlySet<string>;
  matcher: LineMatcher;
  onMatches: MatchSink;
  root: RuntimeWorkspaceRoot;
  signal: AbortSignal | undefined;
  state: LiveSearchState;
}): Promise<void> {
  const guard = createAgentIgnoreGuard(args.canonicalRootPath);
  for (const relativePath of args.filePathAllow) {
    args.signal?.throwIfAborted();
    const absolutePath = await resolveScopedGrepFile({
      canonicalRootPath: args.canonicalRootPath,
      relativePath,
    });
    if (absolutePath === null) {
      continue;
    }
    const candidate = {
      absolutePath,
      relativePath,
      rootId: args.root.rootId,
      rootName: args.root.displayName,
    };
    if ((await dropAgentIgnored(args.canonicalRootPath, [candidate], guard)).length === 0) {
      continue;
    }
    if (args.state.candidateCount >= maxLiveCandidateFiles) {
      args.state.candidateCapHit = true;
      return;
    }
    args.state.candidateCount += 1;
    await emitCandidate({ ...args, candidate, exactScope: true });
  }
}

/**
 * Streams one root's ripgrep candidates through the same filters and matcher
 * as they arrive: the first matching file is matched and handed on while rg is
 * still walking the rest. Reaching the candidate cap stops rg.
 */
async function searchRipgrepRoot(args: {
  canonicalRootPath: string;
  caseSensitive: boolean;
  contextLines: number;
  matcher: LineMatcher;
  onMatches: MatchSink;
  /** The fixed-string SUPERSET literal, or null to list every eligible file. */
  prefilterLiteral: string | null;
  ripgrepPath: string;
  root: RuntimeWorkspaceRoot;
  signal: AbortSignal | undefined;
  state: LiveSearchState;
}): Promise<void> {
  const { canonicalRootPath, root, state } = args;
  const policy = createBackgroundIndexingEntryPolicy({ preset: 'balanced' });
  const guard = createAgentIgnoreGuard(canonicalRootPath);
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let rgEnded = false;
  const stream = streamRipgrep(
    {
      canonicalRootPath,
      caseSensitive: args.caseSensitive,
      mode: args.prefilterLiteral === null ? 'files' : 'matches',
      prefilterLiteral: args.prefilterLiteral ?? undefined,
      ripgrepPath: args.ripgrepPath,
      signal: args.signal,
    },
    (relativePath) => {
      queue.push(relativePath);
      wake?.();
    }
  );
  const settle = (): void => {
    rgEnded = true;
    wake?.();
  };
  stream.done.then(settle, settle);
  for (;;) {
    if (args.signal?.aborted) {
      break;
    }
    const relativePath = queue.shift();
    if (relativePath === undefined) {
      if (rgEnded) {
        break;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
      continue;
    }
    if (state.candidateCount >= maxLiveCandidateFiles) {
      state.candidateCapHit = true;
      stream.stop();
      break;
    }
    const candidate = await resolveCandidate({ canonicalRootPath, policy, relativePath, root });
    if (
      !candidate ||
      (await dropAgentIgnored(canonicalRootPath, [candidate], guard)).length === 0
    ) {
      continue;
    }
    state.candidateCount += 1;
    await emitCandidate({ ...args, candidate, exactScope: false });
  }
  const outcome = await stream.done;
  state.prefilterTruncated = state.prefilterTruncated || outcome.truncated;
  state.partialReadErrors = state.partialReadErrors || outcome.partialReadErrors;
  state.timedOut = state.timedOut || outcome.timedOut;
}

/**
 * Drop candidates excluded by an agent ignore file (BST-1432), checking both
 * the candidate's own path and, for an in-root symlink, its target's.
 */
async function dropAgentIgnored(
  canonicalRootPath: string,
  candidates: readonly LiveCandidate[],
  guard = createAgentIgnoreGuard(canonicalRootPath)
): Promise<LiveCandidate[]> {
  if (candidates.length === 0) {
    return [];
  }
  const verdicts = await Promise.all(
    candidates.map(async (candidate) => {
      const targetRelative = path
        .relative(canonicalRootPath, candidate.absolutePath)
        .split(path.sep)
        .join('/');
      return (
        (await guard.ignoresFile(candidate.relativePath)) ||
        (targetRelative !== candidate.relativePath && (await guard.ignoresFile(targetRelative)))
      );
    })
  );
  return candidates.filter((_candidate, index) => verdicts[index] !== true);
}

/** What a finished live search covered, with every cap it hit named. */
function liveOutcome(
  state: LiveSearchState,
  search: { exactScope: boolean; prefilterLiteral: string | null }
): LiveGrepOutcome {
  if (!state.anyRootAccessible) {
    return {
      candidatesTruncated: false,
      engine: 'skipped',
      note: 'No workspace root was readable on disk for the live pass.',
      scanLimited: false,
      timedOut: false,
      truncated: false,
      unreadableRoots: state.unreadableRoots,
    };
  }
  const scanLimited =
    !search.exactScope && search.prefilterLiteral === null && state.candidateCapHit;
  const candidatesTruncated = state.prefilterTruncated || state.candidateCapHit || state.timedOut;
  const note = buildLiveNote({
    candidateTruncated: state.candidateCapHit && !scanLimited,
    partialReadErrors: state.partialReadErrors,
    prefilterTruncated: state.prefilterTruncated,
    scanLimited,
    timedOut: state.timedOut,
    unreadableRoots: state.unreadableRoots.map((root) => root.displayName),
  });
  return {
    candidatesTruncated,
    engine: search.exactScope ? 'js-files' : 'ripgrep',
    scanLimited,
    timedOut: state.timedOut,
    truncated: candidatesTruncated,
    unreadableRoots: state.unreadableRoots,
    ...(note ? { note } : {}),
  };
}

/**
 * Stream a LIVE grep over the on-disk workspace roots. Each file's matches go
 * to `onMatches` as soon as that file is read, while ripgrep is still walking;
 * the returned outcome names every cap the search hit. The agent's grepSearch
 * and the Explorer's Search tab both run this one core.
 *
 * Exact scopes resolve requested files directly. Otherwise the bundled ripgrep
 * streams candidates, and each is read and run through the authoritative JS
 * matcher.
 *
 * Superset soundness (so the prefilter never silently drops a real match):
 * - Exclusions: ripgrep runs with its own .gitignore/.ignore/hidden filtering
 *   DISABLED (`--no-ignore --hidden`), so its candidate set is a raw superset;
 *   the balanced entry policy, the `.git` re-assertion, realpath containment,
 *   the agent ignore files and the credential floor are the SINGLE authority on
 *   what is excluded.
 * - Binary detection: ripgrep treats every file as text (`--text`), because the
 *   exclusion authority (`isBinaryFile`, the entry policy) is EXTENSION-based.
 * - Matching: ripgrep ONLY ever prefilters on a FIXED-STRING literal, never a
 *   raw regex. For a regex that literal is the longest guaranteed-present
 *   substring (`extractTrigramLiteral`). A regex with NO extractable literal has
 *   ripgrep list every eligible file instead (`scanLimited` once that hits the
 *   candidate cap) rather than trusting rg's narrower Rust regex dialect.
 *
 * A ripgrep timeout or output cap keeps what was found and says so; a ripgrep
 * that cannot run rejects. An invalid regex is the caller's responsibility (the
 * matcher is built upstream and throws before this runs). An abort rejects with
 * the signal's reason, and no match is emitted after it.
 */
export async function streamLiveGrep(
  options: LiveGrepOptions,
  matcher: LineMatcher,
  onMatches: MatchSink
): Promise<LiveGrepOutcome> {
  if (options.roots.length === 0) {
    return {
      candidatesTruncated: false,
      engine: 'skipped',
      scanLimited: false,
      timedOut: false,
      truncated: false,
      unreadableRoots: [],
    };
  }
  const { signal } = options;
  // BST-764. `filePaths` arrives ALREADY normalized to root-relative form by
  // `resolveGrepFilePaths`. Do NOT reintroduce a local transform here: a second,
  // different normalization once reported a clean zero-match for a file that
  // plainly matched. `undefined` is the only spelling of "no filter"; an EMPTY
  // allowlist scopes the search to nothing.
  const filePathAllow = options.filePaths === undefined ? null : new Set(options.filePaths);
  const prefilterLiteral = resolveRipgrepPrefilterLiteral({
    isRegex: options.isRegex,
    pattern: options.pattern,
  });
  const ripgrepPath = filePathAllow === null ? bundledRipgrepPath() : null;
  const state: LiveSearchState = {
    anyRootAccessible: false,
    candidateCapHit: false,
    candidateCount: 0,
    partialReadErrors: false,
    prefilterTruncated: false,
    timedOut: false,
    unreadableRoots: [],
  };

  try {
    for (const root of options.roots) {
      signal?.throwIfAborted();
      if (state.candidateCapHit) {
        break;
      }
      let canonicalRootPath: string;
      try {
        canonicalRootPath = await fsPromises.realpath(root.path);
      } catch (error) {
        logger.warn('live grep: root is not accessible', {
          error: redactErrorForLog(error),
          rootId: root.rootId,
        });
        state.unreadableRoots.push(root);
        continue;
      }
      state.anyRootAccessible = true;
      const common = {
        canonicalRootPath,
        contextLines: options.contextLines,
        matcher,
        onMatches,
        root,
        signal,
        state,
      };
      if (filePathAllow === null) {
        await searchRipgrepRoot({
          ...common,
          caseSensitive: options.caseSensitive,
          prefilterLiteral,
          ripgrepPath: ripgrepPath ?? bundledRipgrepPath(),
        });
      } else {
        await searchScopedRoot({ ...common, filePathAllow });
      }
    }
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    throw error;
  }

  return liveOutcome(state, { exactScope: filePathAllow !== null, prefilterLiteral });
}

/** {@link streamLiveGrep}, with every match collected (the agent's grepSearch). */
export async function runLiveGrep(
  options: LiveGrepOptions,
  matcher: LineMatcher
): Promise<LiveGrepResult> {
  const matches: GrepMatch[] = [];
  const outcome = await streamLiveGrep(options, matcher, (found) => {
    matches.push(...found);
  });
  return { ...outcome, matches };
}
