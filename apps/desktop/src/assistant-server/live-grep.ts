import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import type { GrepMatch, LineMatcher } from '@brainstrike/db';
import { collectGrepMatchesInContent } from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import { createBackgroundIndexingEntryPolicy } from '@brainstrike/utils';
import { createAgentIgnoreGuard } from './agent-ignore-guard';
import { resolveScopedGrepFile } from './live-grep-files';
import { buildLiveNote } from './live-grep-note';
import {
  PROBE_RIPGREP_TIMEOUT_MS,
  RipgrepRunError,
  resolveRipgrepPath,
  resolveRipgrepPrefilterLiteral,
  runRipgrep,
} from './live-grep-ripgrep';
import { walkWorkspaceRoot } from './workspace-file-walk';
import { isWithinRoot } from './workspace-path';

// The ripgrep execution layer lives in live-grep-ripgrep.ts (BST-1246 split);
// its public surface is re-exported here so existing consumers keep importing
// from './live-grep'.
export {
  discoverRipgrepPathForTests,
  PROBE_RIPGREP_TIMEOUT_MS,
  type RipgrepFailureMetadata,
  RipgrepRunError,
  resetRipgrepAvailabilityForTests,
} from './live-grep-ripgrep';

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
export const PROBE_EXCLUDED_PATH_MAX_CANDIDATE_FILES = 200;
/** Active candidate cap; overridable in tests so the cap path is exercised without 1500+ files. */
let maxLiveCandidateFiles = DEFAULT_MAX_LIVE_CANDIDATE_FILES;
/** Skip on-disk files larger than this when reading them for the authoritative match. */
const MAX_READ_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Test-only: override the live candidate cap (pass nothing to restore the
 * default). Lets a unit test prove the resolve loop stops at the cap and
 * surfaces `truncated` without materializing thousands of real files.
 */
export function setMaxLiveCandidateFilesForTests(value?: number): void {
  maxLiveCandidateFiles = value ?? DEFAULT_MAX_LIVE_CANDIDATE_FILES;
}

/** Outcome of the live pass: matches plus how the prefilter ran (never silent). */
export interface LiveGrepResult {
  /**
   * BST-1247 substrate cap (rg prefilter stdout cap or the global candidate
   * cap), separate so `truncated` can stay output-only downstream.
   */
  candidatesTruncated: boolean;
  /**
   * The engine that produced the candidate file set:
   * - 'ripgrep'  — `rg` prefilter ran.
   * - 'js-files' — the exact requested files were resolved directly.
   * - 'js-walk'  — `rg` was absent/errored/timed out; bounded JS file-walk used.
   * - 'skipped'  — the live pass could not run at all (e.g. no readable roots).
   */
  engine: 'ripgrep' | 'js-walk' | 'js-files' | 'skipped';
  /** Authoritative matches found fresh on disk (same shape as the indexed path). */
  matches: GrepMatch[];
  /**
   * Non-silent note when the live pass degraded (rg missing/failed) or hit a
   * cap. Surfaced to the model so freshness limits are never hidden. Undefined on
   * the clean path.
   */
  note?: string;
  scanLimited: boolean;
  /** True when any live cap was hit (more may exist, unreached) — the union of the two flags above plus the prefilter cap. */
  truncated: boolean;
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

export const hasDotGitSegmentForTests = hasDotGitSegment;

type IndexingEntryPolicy = ReturnType<typeof createBackgroundIndexingEntryPolicy>;

/**
 * Keep a ripgrep candidate only when (a) the indexer ignore policy keeps it (so
 * the live pass excludes exactly what glob/the indexer excludes — single source
 * of truth, not rg's `.gitignore`) and (b) its realpath stays inside the
 * canonical root (symlink-escape defence, mirroring glob).
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
    if (exactScope) {
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
    // The indexed path reports root-relative paths without a leading slash; mirror
    // that so live + indexed matches dedupe on identical (rootId, path, line) keys.
    path: candidate.relativePath,
    rootId: candidate.rootId,
    rootName: candidate.rootName,
    startLine: 1,
  });
}

/** Collect candidate paths for one root via the bounded JS file-walk fallback. */
async function collectJsWalkCandidates(
  root: RuntimeWorkspaceRoot
): Promise<{ candidates: LiveCandidate[]; scanLimited: boolean }> {
  const candidates: LiveCandidate[] = [];
  const { scanLimited } = await walkWorkspaceRoot({
    includeIgnored: false,
    onFile: ({ relativePath, absolutePath }) => {
      candidates.push({
        absolutePath,
        relativePath,
        rootId: root.rootId,
        rootName: root.displayName,
      });
    },
    root,
  });
  return { candidates, scanLimited };
}

/** Collect candidate paths for one root via ripgrep, filtered by the ignore policy. */
async function collectRipgrepCandidates(args: {
  ripgrepPath: string;
  root: RuntimeWorkspaceRoot;
  canonicalRootPath: string;
  /** Fixed-string SUPERSET literal rg prefilters on (never the raw regex). */
  prefilterLiteral: string;
  caseSensitive: boolean;
  /** Remaining global candidate budget — STOP resolving once this is reached. */
  maxCandidates: number;
}): Promise<{
  candidates: LiveCandidate[];
  prefilterTruncated: boolean;
  capHit: boolean;
  partialReadErrors: boolean;
}> {
  const run = await runRipgrep({
    canonicalRootPath: args.canonicalRootPath,
    caseSensitive: args.caseSensitive,
    prefilterLiteral: args.prefilterLiteral,
    ripgrepPath: args.ripgrepPath,
  });
  const policy = createBackgroundIndexingEntryPolicy({ preset: 'balanced' });
  const candidates: LiveCandidate[] = [];
  let capHit = false;
  for (const relativePath of run.candidatePaths) {
    // Bound the realpath+stat syscall burst by the SAME cap as the reads: a very
    // common literal in a huge repo can make rg emit tens of thousands of
    // candidate paths, so stop resolving once the budget is spent (surfaced via
    // capHit → the candidate-cap note) instead of statting them all before the
    // final slice trims them.
    if (candidates.length >= args.maxCandidates) {
      capHit = true;
      break;
    }
    const candidate = await resolveCandidate({
      canonicalRootPath: args.canonicalRootPath,
      policy,
      relativePath,
      root: args.root,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return {
    candidates,
    capHit,
    partialReadErrors: run.partialReadErrors,
    prefilterTruncated: run.truncated,
  };
}

export interface LiveGrepOptions {
  caseSensitive: boolean;
  contextLines: number;
  /** Optional exact-path allowlist (workspace-relative, no leading slash). */
  filePaths?: readonly string[];
  isRegex: boolean;
  pattern: string;
  roots: readonly RuntimeWorkspaceRoot[];
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
      filesOnly: true,
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
    candidatePaths = run.candidatePaths;
  } catch (error) {
    if (args.signal.aborted) {
      return empty;
    }
    // BST-1246: the probe is a bounded best-effort hint (1.5s budget over
    // policy-EXCLUDED trees, node_modules included by design). Blowing that
    // budget on a big repo is the expected bounded outcome, not an anomaly —
    // it logs at debug with the timing metadata. Any other failure stays a
    // warn, now with the non-sensitive metadata attached.
    const metadata = error instanceof RipgrepRunError ? error.metadata : undefined;
    if (metadata?.timedOut) {
      logger.debug(
        'excluded-path grep probe: ripgrep hit its bounded time budget; reporting as unfinished',
        {
          ripgrep: metadata,
          rootId: args.root.rootId,
        }
      );
      return { matchCount: 0, timedOut: true };
    }
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
 * A missing root-wide prefilter never triggers a workspace walk.
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
    const ripgrepPath = await resolveRipgrepPath();
    const prefilterLiteral = resolveRipgrepPrefilterLiteral({
      isRegex: options.isRegex,
      pattern: options.pattern,
    });
    if (ripgrepPath === null || prefilterLiteral === null || signal.aborted) {
      return empty;
    }

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

/**
 * Run a LIVE grep over the on-disk workspace roots, returning fresh matches the
 * indexed path may miss (just-edited / unindexed / not-yet-reindexed content).
 *
 * Exact scopes resolve requested files directly. Otherwise a FAST prefilter
 * (ripgrep, or a bounded JS file-walk) finds candidates. Each is read and run
 * through the SAME authoritative JS matcher the indexed service uses — so live
 * and indexed matches are shaped identically.
 *
 * Superset soundness (so the prefilter never silently drops a real match):
 * - Exclusions: ripgrep runs with its own .gitignore/.ignore/hidden filtering
 *   DISABLED (`--no-ignore --hidden`), so its candidate set is a raw superset;
 *   the indexer policy (`createBackgroundIndexingEntryPolicy`) + the `.git`
 *   re-assertion + realpath containment in resolveCandidate are the SINGLE
 *   authority on what is excluded — matching the JS-walk fallback exactly.
 * - Binary detection: ripgrep treats every file as text (`--text`), because the
 *   exclusion authority (`isBinaryFile`, the indexer policy) is EXTENSION-based.
 *   Otherwise rg's content heuristic would drop a policy-INCLUDED source file
 *   that happens to contain a NUL byte — a file the JS walk reads as utf8 and
 *   matches — breaking the superset.
 * - Matching: ripgrep ONLY ever prefilters on a FIXED-STRING literal, never a
 *   raw regex. For a regex grep that literal is the longest guaranteed-present
 *   substring (`extractTrigramLiteral`, the SAME extraction the indexed path
 *   uses); since every regex match must contain it, rg cannot drop a file the JS
 *   regex would match. A regex with NO extractable literal (the indexed path's
 *   `scanLimited` case) takes the bounded JS walk instead of trusting rg's
 *   narrower Rust regex dialect.
 * Symlink discipline and path containment are reused from glob (`isWithinRoot`),
 * scoped to the SAME root(s) the indexed path searches.
 *
 * Robust by contract: a missing / failing / timed-out rg degrades to the JS walk
 * (logged + a non-silent `note`), never throwing — grep still returns. An invalid
 * regex is the caller's responsibility (the matcher is built upstream and throws
 * before this runs).
 */
/** Running state while gathering candidate files across the workspace roots. */
interface CandidateGatherState {
  anyRootAccessible: boolean;
  /** The per-root resolve loop stopped at the global candidate cap (more on disk). */
  candidateCapHit: boolean;
  candidates: LiveCandidate[];
  degradedToWalk: boolean;
  degradeReason: string | null;
  /** rg exited 2 with usable candidates: some files were unreadable (BST-1246). */
  partialReadErrors: boolean;
  prefilterTruncated: boolean;
  scanLimited: boolean;
}

async function gatherScopedCandidates(args: {
  canonicalRootPath: string;
  root: RuntimeWorkspaceRoot;
  filePathAllow: ReadonlySet<string>;
  state: CandidateGatherState;
}): Promise<void> {
  const guard = createAgentIgnoreGuard(args.canonicalRootPath);
  for (const relativePath of args.filePathAllow) {
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
    const permitted = await dropAgentIgnored(args.canonicalRootPath, [candidate], guard);
    if (permitted.length === 0) {
      continue;
    }
    if (args.state.candidates.length >= maxLiveCandidateFiles) {
      args.state.candidateCapHit = true;
      return;
    }
    args.state.candidates.push(...permitted);
  }
}

/** Gather candidate files for ONE root, mutating `state` (ripgrep-then-walk fallback). */
async function gatherRootCandidates(args: {
  root: RuntimeWorkspaceRoot;
  ripgrepPath: string | null;
  /**
   * The fixed-string SUPERSET literal ripgrep prefilters on, or null when the
   * pattern is a regex with no extractable literal. A null literal means rg
   * CANNOT be used soundly (its raw-regex match set may be narrower than the JS
   * matcher's) — every root must take the bounded JS walk instead.
   */
  prefilterLiteral: string | null;
  caseSensitive: boolean;
  state: CandidateGatherState;
  /** Exact paths resolved directly before any root-wide candidate work. */
  filePathAllow: ReadonlySet<string> | null;
}): Promise<void> {
  const { root, ripgrepPath, prefilterLiteral, caseSensitive, state, filePathAllow } = args;
  let canonicalRootPath: string;
  try {
    canonicalRootPath = await fsPromises.realpath(root.path);
  } catch (error) {
    logger.warn('live grep: root is not accessible', {
      error: redactErrorForLog(error),
      rootId: root.rootId,
    });
    return;
  }
  state.anyRootAccessible = true;

  if (filePathAllow !== null) {
    await gatherScopedCandidates({ canonicalRootPath, filePathAllow, root, state });
    return;
  }

  // rg is usable only when it is present, has not already failed, AND a safe
  // superset literal exists. A regex with no extractable literal takes the JS
  // walk (it scans candidate files directly, which the authoritative matcher
  // then re-checks) so a narrower rg regex dialect can never silently miss it.
  if (ripgrepPath !== null && prefilterLiteral !== null && !state.degradedToWalk) {
    try {
      const { candidates, prefilterTruncated, capHit, partialReadErrors } =
        await collectRipgrepCandidates({
          canonicalRootPath,
          caseSensitive,
          // Remaining global budget so per-root resolve never overshoots the cap.
          maxCandidates: Math.max(0, maxLiveCandidateFiles - state.candidates.length),
          prefilterLiteral,
          ripgrepPath,
          root,
        });
      state.candidates.push(...(await dropAgentIgnored(canonicalRootPath, candidates)));
      state.prefilterTruncated = state.prefilterTruncated || prefilterTruncated;
      state.candidateCapHit = state.candidateCapHit || capHit;
      state.partialReadErrors = state.partialReadErrors || partialReadErrors;
      return;
    } catch (error) {
      // rg ran but failed/timed out — fall back to the JS walk for THIS and
      // every remaining root, and surface the reason (never silent). The
      // RipgrepRunError message is pattern-free by construction, and its
      // metadata (timeout vs exit code vs signal) is the non-sensitive half
      // the BST-1246 audit was missing under full redaction.
      state.degradedToWalk = true;
      state.degradeReason = error instanceof Error ? error.message : String(error);
      logger.warn('live grep: ripgrep failed; falling back to JS file-walk', {
        error: redactErrorForLog(error),
        ...(error instanceof RipgrepRunError ? { ripgrep: error.metadata } : {}),
      });
    }
  }

  const { candidates, scanLimited } = await collectJsWalkCandidates(root);
  state.candidates.push(...(await dropAgentIgnored(canonicalRootPath, candidates)));
  state.scanLimited = state.scanLimited || scanLimited;
}

/**
 * Drop candidates excluded by an agent ignore file (BST-1432).
 *
 * Applied HERE, where the ripgrep and JS-walk candidate sets converge, so both
 * engines are trimmed by one authority. Enforcing it inside each collector
 * would make the boundary's strength depend on whether `rg` is installed —
 * see `createAgentIgnoreGuard` for the full rationale.
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
        (await guard.ignoresFile(targetRelative))
      );
    })
  );
  return candidates.filter((_candidate, index) => verdicts[index] !== true);
}

export async function runLiveGrep(
  options: LiveGrepOptions,
  matcher: LineMatcher
): Promise<LiveGrepResult> {
  if (options.roots.length === 0) {
    return {
      candidatesTruncated: false,
      engine: 'skipped',
      matches: [],
      scanLimited: false,
      truncated: false,
    };
  }

  // BST-764. `filePaths` arrives ALREADY normalized to root-relative form by
  // `resolveGrepFilePaths`, which both this pass and the indexed pass share.
  //
  // This used to be `p.replace(/^\/+/, '')`, which turned an absolute path into
  // `Users/sean/…` — never equal to the root-relative candidate `proof.html` —
  // and so reported a clean zero-match for a file that plainly matched. Do NOT
  // reintroduce a local transform here: a second, different normalization is
  // exactly how the two passes diverged.
  //
  // Review follow-up on #2087: the guard was `length > 0`, so an EMPTY
  // allowlist meant "nothing" to the indexed pass (`findGrepCandidates` returns
  // no candidates) and "everything" here — `grepSearch({ pattern, filePaths: [] })`
  // walked the whole workspace and merged those matches into a result the
  // caller had scoped to nothing. `undefined` is now the only spelling of "no
  // filter", which is what makes "one list, one meaning" actually true.
  const filePathAllow = options.filePaths === undefined ? null : new Set(options.filePaths);

  const ripgrepPath = filePathAllow === null ? await resolveRipgrepPath() : null;
  const rgPresent = ripgrepPath !== null;
  // The fixed-string SUPERSET literal rg prefilters on. For a regex this is the
  // longest guaranteed-present literal (the SAME extraction the indexed path uses
  // for its trigram prefilter); null when no such literal exists (the indexed
  // path's `scanLimited` case). A null literal means rg cannot soundly prefilter
  // a regex, so the live pass takes the bounded JS walk for every root instead.
  const prefilterLiteral = resolveRipgrepPrefilterLiteral({
    isRegex: options.isRegex,
    pattern: options.pattern,
  });
  const regexNoLiteralPrefilter = options.isRegex && prefilterLiteral === null;
  // rg actually runs only when it is present AND a safe superset literal exists.
  const rgUsed = rgPresent && !regexNoLiteralPrefilter;
  const state: CandidateGatherState = {
    anyRootAccessible: false,
    candidateCapHit: false,
    candidates: [],
    degradedToWalk: false,
    degradeReason: null,
    partialReadErrors: false,
    prefilterTruncated: false,
    scanLimited: false,
  };

  for (const root of options.roots) {
    await gatherRootCandidates({
      caseSensitive: options.caseSensitive,
      filePathAllow,
      prefilterLiteral,
      ripgrepPath,
      root,
      state,
    });
  }

  if (!state.anyRootAccessible) {
    return {
      candidatesTruncated: false,
      engine: 'skipped',
      matches: [],
      note: 'No workspace root was readable on disk for the live pass.',
      scanLimited: false,
      truncated: false,
    };
  }

  const engine: LiveGrepResult['engine'] =
    filePathAllow === null ? (state.degradedToWalk || !rgUsed ? 'js-walk' : 'ripgrep') : 'js-files';

  // Apply the optional exact-path allowlist and the global candidate cap. The
  // per-root resolve loop already STOPS at the cap (so the realpath+stat burst
  // is bounded); this slice is the authoritative backstop and also bounds the
  // JS-walk path + the allowlist filter. `candidateCapHit` (resolve stopped
  // early) and a post-filter overflow both mean "more on disk, unreached".
  const filtered = filePathAllow
    ? state.candidates.filter((candidate) => filePathAllow.has(candidate.relativePath))
    : state.candidates;
  const candidateTruncated = state.candidateCapHit || filtered.length > maxLiveCandidateFiles;
  const capped =
    filtered.length > maxLiveCandidateFiles ? filtered.slice(0, maxLiveCandidateFiles) : filtered;

  const matches: GrepMatch[] = [];
  for (const candidate of capped) {
    const fileMatches = await matchCandidate(
      candidate,
      matcher,
      options.contextLines,
      filePathAllow !== null
    );
    matches.push(...fileMatches);
  }

  const truncated = state.prefilterTruncated || state.scanLimited || candidateTruncated;
  const note = buildLiveNote({
    candidateTruncated,
    degradedToWalk: state.degradedToWalk,
    degradeReason: state.degradeReason,
    exactScope: filePathAllow !== null,
    partialReadErrors: state.partialReadErrors,
    prefilterTruncated: state.prefilterTruncated,
    regexNoLiteralPrefilter,
    rgPresent,
    rgUsed,
    scanLimited: state.scanLimited,
  });

  return {
    candidatesTruncated: state.prefilterTruncated || candidateTruncated,
    engine,
    matches,
    scanLimited: state.scanLimited,
    truncated,
    ...(note ? { note } : {}),
  };
}
