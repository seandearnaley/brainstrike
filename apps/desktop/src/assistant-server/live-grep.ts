import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import type { GrepMatch, LineMatcher } from '@brainstrike/db';
import { collectGrepMatchesInContent, extractTrigramLiteral } from '@brainstrike/db';
import { createBackgroundIndexingEntryPolicy } from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import { walkWorkspaceRoot } from './workspace-file-walk';
import { isWithinRoot } from './workspace-path';

const logger = createLogger('AssistantLiveGrep');

/**
 * ripgrep executable name(s) to look for. On Windows the binary is `rg.exe`; on
 * every other platform it is `rg`. We probe BOTH so a misconfigured PATHEXT or a
 * `.exe` on a POSIX-ish shell still resolves.
 */
const RIPGREP_BINARY_NAMES =
  process.platform === 'win32' ? (['rg.exe', 'rg'] as const) : (['rg'] as const);

/**
 * Fallback install locations probed ONLY when ripgrep is not on `PATH`. Covers
 * Homebrew (Apple-silicon + Intel), the common `/usr/local` install, the distro
 * package location, and the Windows winget/scoop/choco shim dir. Order is
 * preference; the first executable hit wins.
 */
const RIPGREP_FALLBACK_DIRS: readonly string[] =
  process.platform === 'win32'
    ? [
        path.join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WinGet', 'Links'),
        path.join(process.env['USERPROFILE'] ?? '', 'scoop', 'shims'),
        path.join(process.env['ProgramData'] ?? '', 'chocolatey', 'bin'),
      ]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

/** Wall-clock bound for one ripgrep prefilter invocation (per root). */
const RIPGREP_TIMEOUT_MS = 4000;
/** Cap on ripgrep stdout (~bytes) so a pathological match set can't blow memory. */
const RIPGREP_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Skip files larger than this in the prefilter (mirrors the indexer's intent). */
const RIPGREP_MAX_FILESIZE = '2M';
/** Per-file match cap in the prefilter — we only need candidacy, not every hit. */
const RIPGREP_MAX_COUNT_PER_FILE = 200;
/** Default hard cap on candidate files materialized from the live pass (per call, all roots). */
const DEFAULT_MAX_LIVE_CANDIDATE_FILES = 1500;
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
   * The engine that produced the candidate file set:
   * - 'ripgrep'  — `rg` prefilter ran.
   * - 'js-walk'  — `rg` was absent/errored/timed out; bounded JS file-walk used.
   * - 'skipped'  — the live pass could not run at all (e.g. no readable roots).
   */
  engine: 'ripgrep' | 'js-walk' | 'skipped';
  /** Authoritative matches found fresh on disk (same shape as the indexed path). */
  matches: GrepMatch[];
  /**
   * Non-silent note when the live pass degraded (rg missing/failed) or hit a
   * cap. Surfaced to the model so freshness limits are never hidden. Undefined on
   * the clean path.
   */
  note?: string;
  /** True when a candidate cap or per-root scan cap was hit (more may exist, unreached). */
  truncated: boolean;
}

/** A live candidate file to read + match, labelled with its owning root. */
interface LiveCandidate {
  absolutePath: string;
  relativePath: string;
  rootId: string;
  rootName: string;
}

/**
 * Memoized ripgrep resolution. `undefined` = not probed yet; `null` = probed,
 * absent; a string = the resolved absolute path. Memoized so the (cheap) PATH
 * scan runs once per process, like the prior probe.
 */
let resolvedRipgrepPath: string | null | undefined;

/** True when `candidate` is an existing, executable regular file. */
async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(candidate);
    if (!stat.isFile()) {
      return false;
    }
    // X_OK is advisory on Windows (always passes), which is fine: there the
    // extension (.exe) is what makes it runnable, and we only probe rg.exe.
    await fsPromises.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover ripgrep on disk WITHOUT a hardcoded install path: scan every `PATH`
 * directory for an executable `rg` (`rg.exe` on Windows), then fall back to a
 * small list of common install dirs only if PATH has none. Returns the resolved
 * absolute path, or null when ripgrep is genuinely unavailable (→ JS-walk).
 */
async function discoverRipgrepPath(): Promise<string | null> {
  const pathDirs = (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter((dir) => dir.length > 0);
  // PATH first (respects the user's environment), then the fallback dirs.
  for (const dir of [...pathDirs, ...RIPGREP_FALLBACK_DIRS]) {
    for (const name of RIPGREP_BINARY_NAMES) {
      const candidate = path.join(dir, name);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Resolve (once, memoized) the absolute path to a runnable ripgrep, or null when
 * it is unavailable. A null result flips the live pass to the JS-walk fallback
 * rather than failing the grep.
 */
async function resolveRipgrepPath(): Promise<string | null> {
  if (resolvedRipgrepPath !== undefined) {
    return resolvedRipgrepPath;
  }
  resolvedRipgrepPath = await discoverRipgrepPath();
  return resolvedRipgrepPath;
}

/**
 * Test-only: run the (un-memoized) ripgrep discovery and return the resolved
 * absolute path (or null). Lets a test assert rg was resolved from a PATH entry
 * rather than a hardcoded location.
 */
export function discoverRipgrepPathForTests(): Promise<string | null> {
  return discoverRipgrepPath();
}

/** Test-only: reset the memoized ripgrep resolution between cases. */
export function resetRipgrepAvailabilityForTests(): void {
  resolvedRipgrepPath = undefined;
}

/**
 * The literal ripgrep prefilters on. ripgrep ONLY ever runs in `--fixed-strings`
 * mode (never on a raw regex) so its match set is always a guaranteed SUPERSET of
 * the authoritative JS matcher's:
 * - For a literal grep the prefilter literal IS the pattern.
 * - For a regex grep it is the longest guaranteed-present literal extracted by
 *   {@link extractTrigramLiteral} (the SAME extraction the indexed path uses to
 *   drive its trigram prefilter). A regex match must contain that literal, so
 *   prefiltering on it can never drop a file the JS regex would match.
 *
 * `null` means "no safe prefilter literal" (a regex with no extractable ≥3-char
 * literal — the indexed path's `scanLimited` case). The caller MUST NOT hand the
 * raw regex to ripgrep then (Rust's regex dialect can match a NARROWER set than
 * JS `RegExp`, silently dropping files); it falls back to the bounded JS walk.
 */
function resolveRipgrepPrefilterLiteral(args: {
  pattern: string;
  isRegex: boolean;
}): string | null {
  return args.isRegex ? extractTrigramLiteral(args.pattern) : args.pattern;
}

/** Build the ripgrep argument list for a fixed-string (literal) prefilter. */
function buildRipgrepArgs(args: { prefilterLiteral: string; caseSensitive: boolean }): string[] {
  const rgArgs = [
    '--json',
    '--no-config',
    '--no-follow',
    // The indexer policy (re-applied in resolveCandidate) is the SINGLE source of
    // truth for exclusions, so disable ripgrep's own .gitignore/.ignore/.rgignore
    // and hidden-file filtering. Otherwise rg drops files (gitignored-but-present,
    // dotfiles like `.github/...`) that the JS-walk fallback keeps, so rg's
    // candidate set would not be a SUPERSET of the JS walk's and the live pass
    // would silently miss fresh content. `--no-ignore` already implies
    // --no-ignore-global/--no-ignore-parent/--no-ignore-vcs. (`.git` is still
    // hard-excluded and realpath-containment-checked in resolveCandidate.)
    '--no-ignore',
    '--hidden',
    // Prune the two directories the indexer policy excludes UNCONDITIONALLY by
    // name at ANY depth (`.git` is hard-excluded in resolveCandidate; both are in
    // the 'balanced' policy's excluded directory segments). `--no-ignore --hidden`
    // would otherwise make rg DESCEND into them — a pure regression vs the JS
    // walk, which prunes at the directory boundary (`policy.shouldTraverseDirectory`).
    // Two harms: (a) a populated node_modules can blow RIPGREP_TIMEOUT_MS → the
    // whole pass degrades to the JS walk (defeating rg); (b) rg emits in traversal
    // order and `node_modules` sorts before `src`, so the 32MB --max-buffer can
    // fill with (policy-filtered-to-nothing) node_modules candidates while real
    // fresh src/ matches fall off the end → genuinely MISSED. These globs prune
    // ONLY dirs the policy already hard-excludes by name, so the candidate set
    // stays a strict SUPERSET of policy-kept files (parity with the JS walk).
    '--glob=!**/.git/',
    '--glob=!**/node_modules/',
    // Treat EVERY file as text. By default rg's content heuristic skips any file
    // with a NUL byte before the first match (no `begin` event → never a
    // candidate), but brainstrike's exclusion authority (`isBinaryFile`, the
    // indexer policy) is EXTENSION-based: a `.ts`/`.md`/`.json` file with a NUL
    // byte (UTF-16 content, an embedded blob, a partial save) is INCLUDED by the
    // policy and read as utf8 by the JS-walk + the authoritative matcher. Without
    // `--text` rg would drop exactly those files, so its candidate set would not
    // be a SUPERSET of the JS walk's and the live pass would silently miss them.
    // Extension/size exclusions remain the single authority via resolveCandidate.
    '--text',
    `--max-filesize=${RIPGREP_MAX_FILESIZE}`,
    `--max-count=${RIPGREP_MAX_COUNT_PER_FILE}`,
    // Always fixed-strings: rg is a literal SUPERSET prefilter only; the
    // authoritative literal/regex match is re-derived by the shared JS matcher.
    '--fixed-strings',
  ];
  if (args.caseSensitive) {
    rgArgs.push('--case-sensitive');
  } else {
    rgArgs.push('--ignore-case');
  }
  // `--` terminates options so a literal starting with `-` is not parsed as a flag.
  rgArgs.push('--', args.prefilterLiteral, '.');
  return rgArgs;
}

interface RipgrepRun {
  /** Workspace-relative POSIX candidate paths (no leading slash) with ≥1 match. */
  candidatePaths: Set<string>;
  /** True when stdout was truncated (max-buffer hit) — candidate set is partial. */
  truncated: boolean;
}

/**
 * Spawn ripgrep in `canonicalRootPath` and collect the set of candidate file
 * paths (those with ≥1 match). ripgrep is the FAST disk prefilter only, run on a
 * fixed-string SUPERSET literal (never a raw regex); the authoritative match (and
 * final ignore/containment filtering) is re-derived in JS, so ripgrep's match
 * dialect can never diverge the results. Bounded by timeout, max-filesize,
 * max-count, and max-buffer. Throws on spawn/exec failure so the caller can fall
 * back to the JS walk.
 */
function runRipgrep(args: {
  ripgrepPath: string;
  canonicalRootPath: string;
  prefilterLiteral: string;
  caseSensitive: boolean;
}): Promise<RipgrepRun> {
  return new Promise<RipgrepRun>((resolve, reject) => {
    execFile(
      args.ripgrepPath,
      buildRipgrepArgs(args),
      {
        cwd: args.canonicalRootPath,
        timeout: RIPGREP_TIMEOUT_MS,
        maxBuffer: RIPGREP_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        // rg exit code 1 = "no matches" (not an error); 2 = a real error. The
        // callback's `error` is set for both non-zero exits and for the timeout/
        // max-buffer kills, so distinguish via the captured stdout we still have.
        const execError = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const truncated = execError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        if (execError?.killed && !truncated) {
          reject(execError);
          return;
        }
        // Exit code 2 (genuine rg error) arrives as a numeric `code`; treat it
        // as a failure so the caller falls back. Exit 1 / 0 yield usable stdout.
        if (execError && typeof execError.code === 'number' && execError.code > 1) {
          reject(execError);
          return;
        }
        resolve({ candidatePaths: parseRipgrepCandidates(stdout), truncated });
      }
    );
  });
}

/** Parse `rg --json` stdout into the set of workspace-relative candidate paths. */
function parseRipgrepCandidates(stdout: string): Set<string> {
  const paths = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRipgrepBeginEvent(event)) {
      continue;
    }
    const text = event.data.path.text;
    // rg prints paths relative to cwd (the root), e.g. "./src/x.ts" or "src/x.ts".
    const normalized = text.replace(/^\.\//, '').replaceAll('\\', '/');
    if (normalized.length > 0) {
      paths.add(normalized);
    }
  }
  return paths;
}

interface RipgrepBeginEvent {
  data: { path: { text: string } };
  type: 'begin';
}

function isRipgrepBeginEvent(value: unknown): value is RipgrepBeginEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const event = value as { type?: unknown; data?: unknown };
  if (event.type !== 'begin' || typeof event.data !== 'object' || event.data === null) {
    return false;
  }
  const data = event.data as { path?: unknown };
  if (typeof data.path !== 'object' || data.path === null) {
    return false;
  }
  return typeof (data.path as { text?: unknown }).text === 'string';
}

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
  if (args.relativePath.split('/').some((segment) => segment === '.git')) {
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
  contextLines: number
): Promise<GrepMatch[]> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fsPromises.stat(candidate.absolutePath);
  } catch {
    return [];
  }
  if (stat.size > MAX_READ_FILE_BYTES) {
    return [];
  }
  let content: string;
  try {
    content = await fsPromises.readFile(candidate.absolutePath, 'utf8');
  } catch (error) {
    logger.debug('live grep: unreadable candidate skipped', {
      path: candidate.relativePath,
      error,
    });
    return [];
  }
  return collectGrepMatchesInContent({
    content,
    matcher,
    contextLines,
    // The indexed path reports root-relative paths without a leading slash; mirror
    // that so live + indexed matches dedupe on identical (rootId, path, line) keys.
    path: candidate.relativePath,
    startLine: 1,
    rootId: candidate.rootId,
    rootName: candidate.rootName,
  });
}

/** Collect candidate paths for one root via the bounded JS file-walk fallback. */
async function collectJsWalkCandidates(
  root: RuntimeWorkspaceRoot
): Promise<{ candidates: LiveCandidate[]; scanLimited: boolean }> {
  const candidates: LiveCandidate[] = [];
  const { scanLimited } = await walkWorkspaceRoot({
    root,
    includeIgnored: false,
    onFile: ({ relativePath, absolutePath }) => {
      candidates.push({
        absolutePath,
        relativePath,
        rootId: root.rootId,
        rootName: root.displayName,
      });
    },
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
}): Promise<{ candidates: LiveCandidate[]; prefilterTruncated: boolean; capHit: boolean }> {
  const run = await runRipgrep({
    ripgrepPath: args.ripgrepPath,
    canonicalRootPath: args.canonicalRootPath,
    prefilterLiteral: args.prefilterLiteral,
    caseSensitive: args.caseSensitive,
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
      relativePath,
      canonicalRootPath: args.canonicalRootPath,
      root: args.root,
      policy,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return { candidates, prefilterTruncated: run.truncated, capHit };
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

/**
 * Run a LIVE grep over the on-disk workspace roots, returning fresh matches the
 * indexed path may miss (just-edited / unindexed / not-yet-reindexed content).
 *
 * Two-phase, mirroring the indexed path: a FAST prefilter (ripgrep, or a bounded
 * JS file-walk) finds candidate files, then each candidate is read and run
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
  prefilterTruncated: boolean;
  scanLimited: boolean;
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
}): Promise<void> {
  const { root, ripgrepPath, prefilterLiteral, caseSensitive, state } = args;
  let canonicalRootPath: string;
  try {
    canonicalRootPath = await fsPromises.realpath(root.path);
  } catch (error) {
    logger.warn('live grep: root is not accessible', { rootId: root.rootId, error });
    return;
  }
  state.anyRootAccessible = true;

  // rg is usable only when it is present, has not already failed, AND a safe
  // superset literal exists. A regex with no extractable literal takes the JS
  // walk (it scans candidate files directly, which the authoritative matcher
  // then re-checks) so a narrower rg regex dialect can never silently miss it.
  if (ripgrepPath !== null && prefilterLiteral !== null && !state.degradedToWalk) {
    try {
      const { candidates, prefilterTruncated, capHit } = await collectRipgrepCandidates({
        ripgrepPath,
        root,
        canonicalRootPath,
        prefilterLiteral,
        caseSensitive,
        // Remaining global budget so per-root resolve never overshoots the cap.
        maxCandidates: Math.max(0, maxLiveCandidateFiles - state.candidates.length),
      });
      state.candidates.push(...candidates);
      state.prefilterTruncated = state.prefilterTruncated || prefilterTruncated;
      state.candidateCapHit = state.candidateCapHit || capHit;
      return;
    } catch (error) {
      // rg ran but failed/timed out — fall back to the JS walk for THIS and
      // every remaining root, and surface the reason (never silent).
      state.degradedToWalk = true;
      state.degradeReason = error instanceof Error ? error.message : String(error);
      logger.warn('live grep: ripgrep failed; falling back to JS file-walk', { error });
    }
  }

  const { candidates, scanLimited } = await collectJsWalkCandidates(root);
  state.candidates.push(...candidates);
  state.scanLimited = state.scanLimited || scanLimited;
}

export async function runLiveGrep(
  options: LiveGrepOptions,
  matcher: LineMatcher
): Promise<LiveGrepResult> {
  if (options.roots.length === 0) {
    return { matches: [], engine: 'skipped', truncated: false };
  }

  const filePathAllow =
    options.filePaths && options.filePaths.length > 0
      ? new Set(options.filePaths.map((p) => p.replace(/^\/+/, '')))
      : null;

  const ripgrepPath = await resolveRipgrepPath();
  const rgPresent = ripgrepPath !== null;
  // The fixed-string SUPERSET literal rg prefilters on. For a regex this is the
  // longest guaranteed-present literal (the SAME extraction the indexed path uses
  // for its trigram prefilter); null when no such literal exists (the indexed
  // path's `scanLimited` case). A null literal means rg cannot soundly prefilter
  // a regex, so the live pass takes the bounded JS walk for every root instead.
  const prefilterLiteral = resolveRipgrepPrefilterLiteral({
    pattern: options.pattern,
    isRegex: options.isRegex,
  });
  const regexNoLiteralPrefilter = options.isRegex && prefilterLiteral === null;
  // rg actually runs only when it is present AND a safe superset literal exists.
  const rgUsed = rgPresent && !regexNoLiteralPrefilter;
  const state: CandidateGatherState = {
    anyRootAccessible: false,
    candidates: [],
    candidateCapHit: false,
    degradeReason: null,
    degradedToWalk: false,
    prefilterTruncated: false,
    scanLimited: false,
  };

  for (const root of options.roots) {
    await gatherRootCandidates({
      root,
      ripgrepPath,
      prefilterLiteral,
      caseSensitive: options.caseSensitive,
      state,
    });
  }

  if (!state.anyRootAccessible) {
    return {
      matches: [],
      engine: 'skipped',
      truncated: false,
      note: 'No workspace root was readable on disk for the live pass.',
    };
  }

  const engine: LiveGrepResult['engine'] = state.degradedToWalk || !rgUsed ? 'js-walk' : 'ripgrep';

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
    const fileMatches = await matchCandidate(candidate, matcher, options.contextLines);
    matches.push(...fileMatches);
  }

  const truncated = state.prefilterTruncated || state.scanLimited || candidateTruncated;
  const note = buildLiveNote({
    rgPresent,
    rgUsed,
    regexNoLiteralPrefilter,
    degradedToWalk: state.degradedToWalk,
    degradeReason: state.degradeReason,
    scanLimited: state.scanLimited,
    candidateTruncated,
    prefilterTruncated: state.prefilterTruncated,
  });

  return {
    matches,
    engine,
    truncated,
    ...(note ? { note } : {}),
  };
}

/** Compose the non-silent live-pass note (degradation + cap warnings), or undefined when clean. */
function buildLiveNote(args: {
  rgPresent: boolean;
  rgUsed: boolean;
  regexNoLiteralPrefilter: boolean;
  degradedToWalk: boolean;
  degradeReason: string | null;
  scanLimited: boolean;
  candidateTruncated: boolean;
  prefilterTruncated: boolean;
}): string | undefined {
  const parts: string[] = [];
  if (!args.rgPresent) {
    parts.push('ripgrep is unavailable; the live (on-disk) pass used a bounded file-walk instead.');
  } else if (args.degradedToWalk) {
    parts.push(
      `ripgrep failed (${args.degradeReason ?? 'unknown error'}); the live pass fell back to a bounded file-walk.`
    );
  } else if (args.regexNoLiteralPrefilter) {
    // rg is present but was deliberately not used: this regex has no literal that
    // rg could prefilter on as a guaranteed superset, so the live pass scanned
    // candidate files directly with the authoritative matcher (consistent with
    // the indexed path's scanLimited regex case) rather than trusting rg's
    // narrower regex dialect. Never silent.
    parts.push(
      'The live pass scanned on-disk files without a ripgrep prefilter ' +
        '(this regex has no extractable literal), so it was bounded by the file-walk cap.'
    );
  }
  if (args.scanLimited) {
    parts.push(
      'The live file-walk hit its per-root visit cap, so some on-disk matches may be missing.'
    );
  }
  if (args.candidateTruncated) {
    parts.push(
      'The live pass hit its candidate-file cap; narrow the pattern or scope with filePaths to reach the rest.'
    );
  }
  if (args.prefilterTruncated) {
    parts.push(
      'The live ripgrep prefilter output was truncated; some on-disk matches may be missing.'
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
