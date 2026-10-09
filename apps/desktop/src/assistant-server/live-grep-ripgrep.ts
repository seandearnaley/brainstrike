/**
 * The ripgrep execution layer of the desktop LIVE grep pass: binary discovery,
 * argument construction (including the policy-derived prune globs), the bounded
 * `execFile` invocation, and `--json` candidate parsing. Split from
 * `live-grep.ts` (BST-1246) — that module owns the walk fallback, candidate
 * resolution, the excluded-path probe, and `runLiveGrep` itself, and re-exports
 * this module's public surface for existing consumers.
 */
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { extractTrigramLiteral } from '@brainstrike/db';
import { trackNativeChild } from '@brainstrike/state-store/native-children';
import {
  BALANCED_UNCONDITIONAL_EXCLUDED_DIRECTORY_SEGMENTS,
  UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES,
} from '@brainstrike/utils';

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
/** Shorter per-root ripgrep ceiling for the optional excluded-path probe. */
export const PROBE_RIPGREP_TIMEOUT_MS = 1500;
/** Cap on ripgrep stdout (~bytes) so a pathological match set can't blow memory. */
const RIPGREP_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Skip files larger than this in the prefilter (mirrors the indexer's intent). */
const RIPGREP_MAX_FILESIZE = '2M';
/** Per-file match cap in the prefilter — we only need candidacy, not every hit. */
const RIPGREP_MAX_COUNT_PER_FILE = 200;

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
export async function resolveRipgrepPath(): Promise<string | null> {
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
export function resolveRipgrepPrefilterLiteral(args: {
  pattern: string;
  isRegex: boolean;
}): string | null {
  return args.isRegex ? extractTrigramLiteral(args.pattern) : args.pattern;
}

/**
 * BST-1246: non-sensitive metadata describing WHY an rg run failed. The raw
 * error message/stack stays redacted (execFile's error embeds the full spawned
 * command including the search pattern); these fields carry no user content
 * and make the failure class observable from diagnostics — the 2026-08 audit
 * could not tell timeout from crash because everything was redacted.
 */
export interface RipgrepFailureMetadata {
  readonly elapsedMs: number;
  /** Node error-code string (e.g. ENOENT) when the failure was not an exit code. */
  readonly errorCode: string | null;
  /** Numeric rg exit code when the process exited on its own. */
  readonly exitCode: number | null;
  readonly killed: boolean;
  readonly signal: string | null;
  /** True when the execFile timeout killed the process. */
  readonly timedOut: boolean;
}

/** rg failure with a clean (pattern-free) message plus loggable metadata. */
export class RipgrepRunError extends Error {
  readonly metadata: RipgrepFailureMetadata;

  constructor(message: string, metadata: RipgrepFailureMetadata) {
    super(message);
    this.name = 'RipgrepRunError';
    this.metadata = metadata;
  }
}

/** Build the ripgrep argument list for a fixed-string (literal) prefilter. */
function buildRipgrepArgs(args: {
  prefilterLiteral: string;
  caseSensitive: boolean;
  /**
   * Apply the balanced-policy directory prune (default true; ~27 policy
   * globs plus the `.claude/worktrees` prefix). The excluded-path probe
   * passes false because its PURPOSE is to search policy-excluded trees
   * (only `.git` stays pruned there).
   */
  applyPolicyPrune?: boolean;
  filesOnly?: boolean;
}): string[] {
  const rgArgs = [
    ...(args.filesOnly ? ['--files-with-matches', '--max-count=1'] : ['--json']),
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
    ...(args.filesOnly ? [] : [`--max-count=${RIPGREP_MAX_COUNT_PER_FILE}`]),
    // Always fixed-strings: rg is a literal SUPERSET prefilter only; the
    // authoritative literal/regex match is re-derived by the shared JS matcher.
    '--fixed-strings',
  ];
  // Prune the directories the indexer policy excludes UNCONDITIONALLY by name
  // at ANY depth. `--no-ignore --hidden` would otherwise make rg DESCEND into
  // them — a pure regression vs the JS walk, which prunes at the directory
  // boundary (`policy.shouldTraverseDirectory`). Two harms: (a) artifact trees
  // (.vite sourcemaps, dist, .turbo, coverage — not just node_modules) blew
  // RIPGREP_TIMEOUT_MS on real repos, degrading EVERY grep to the JS walk
  // (BST-1246: 87 of ~112 calls in the 2026-08 audit); (b) rg emits in
  // traversal order, so the 32MB --max-buffer can fill with
  // (policy-filtered-to-nothing) artifact candidates while real fresh src/
  // matches fall off the end → genuinely MISSED. These globs prune ONLY dirs
  // the balanced policy hard-excludes by name (resolveCandidate re-applies the
  // same policy), so the candidate set stays a strict SUPERSET of policy-kept
  // files (parity with the JS walk). The excluded-path probe's PURPOSE is to
  // find matches inside policy-excluded paths, so it keeps everything except
  // `.git` (hard-excluded in resolveCandidate) searchable.
  if (args.applyPolicyPrune ?? true) {
    for (const segment of BALANCED_UNCONDITIONAL_EXCLUDED_DIRECTORY_SEGMENTS) {
      rgArgs.push(`--glob=!**/${segment}/`);
    }
    for (const prefix of UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES) {
      rgArgs.push(`--glob=!${prefix}/**`);
    }
  } else {
    rgArgs.push('--glob=!**/.git/');
  }
  if (args.caseSensitive) {
    rgArgs.push('--case-sensitive');
  } else {
    rgArgs.push('--ignore-case');
  }
  // `--` terminates options so a literal starting with `-` is not parsed as a flag.
  rgArgs.push('--', args.prefilterLiteral, '.');
  return rgArgs;
}

export interface RipgrepRun {
  /** Workspace-relative POSIX candidate paths (no leading slash) with ≥1 match. */
  candidatePaths: Set<string>;
  /**
   * BST-1246: rg exited 2 (some files errored: permission denied, sockets) but
   * still produced usable candidates. The candidates are kept — files rg could
   * not read would be equally unreadable to the authoritative JS matcher — and
   * the condition is surfaced in the live note, never silently.
   */
  partialReadErrors: boolean;
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
export function runRipgrep(args: {
  ripgrepPath: string;
  canonicalRootPath: string;
  prefilterLiteral: string;
  caseSensitive: boolean;
  applyPolicyPrune?: boolean;
  filesOnly?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<RipgrepRun> {
  const timeoutMs = args.timeoutMs ?? RIPGREP_TIMEOUT_MS;
  const startedAt = Date.now();
  return new Promise<RipgrepRun>((resolve, reject) => {
    const child = execFile(
      args.ripgrepPath,
      buildRipgrepArgs(args),
      {
        cwd: args.canonicalRootPath,
        maxBuffer: RIPGREP_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      },
      (error, stdout) => {
        // rg exit code 1 = "no matches" (not an error); 2 = a real error. The
        // callback's `error` is set for both non-zero exits and for the timeout/
        // max-buffer kills, so distinguish via the captured stdout we still have.
        const execError = error as
          | (NodeJS.ErrnoException & { killed?: boolean; signal?: string })
          | null;
        const truncated = execError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        // BST-1246: reject with a CLEAN message (execFile's own embeds the full
        // spawned command including the search pattern) plus the non-sensitive
        // failure metadata the warn sites log — the audit could not distinguish
        // timeout from crash because everything was redacted.
        const buildError = (reason: string): RipgrepRunError => {
          const elapsedMs = Date.now() - startedAt;
          // `timedOut` is a ROUTING decision (the probe silences it to debug),
          // so it must mean "our execFile timeout fired", not merely "killed":
          // cross-check the kill signal (execFile's timeout sends SIGTERM) and
          // the elapsed wall-clock against the budget, so an external
          // SIGKILL/SIGTERM (OOM killer, app shutdown) stays a visible
          // failure instead of vanishing as an expected bounded outcome.
          const timedOut =
            execError?.killed === true &&
            !truncated &&
            args.signal?.aborted !== true &&
            execError?.signal === 'SIGTERM' &&
            elapsedMs >= timeoutMs;
          return new RipgrepRunError(reason, {
            elapsedMs,
            errorCode: typeof execError?.code === 'string' ? execError.code : null,
            exitCode: typeof execError?.code === 'number' ? execError.code : null,
            killed: execError?.killed === true,
            signal: typeof execError?.signal === 'string' ? execError.signal : null,
            timedOut,
          });
        };
        if (args.signal?.aborted) {
          reject(buildError('ripgrep aborted'));
          return;
        }
        if (execError?.killed && !truncated) {
          reject(buildError(`ripgrep timed out after ${timeoutMs}ms`));
          return;
        }
        // Externally signal-terminated (OOM killer, process supervisor):
        // execFile reports code null, a non-null signal, and killed FALSE, so
        // neither branch above fires — without this check the kill resolved
        // as a SUCCESSFUL search over partial/empty stdout and a clean
        // zero-match could mask a dead rg (Codex review). Our own timeout
        // kill carries killed === true and is handled above; max-buffer kills
        // resolve with `truncated` as before.
        if (
          execError &&
          typeof execError.signal === 'string' &&
          execError.signal.length > 0 &&
          !truncated
        ) {
          reject(buildError(`ripgrep terminated by ${execError.signal}`));
          return;
        }
        const parseCandidates = () =>
          args.filesOnly ? parseRipgrepFileCandidates(stdout) : parseRipgrepCandidates(stdout);
        // Exit code 2 arrives as a numeric `code`. rg exits 2 both for
        // catastrophic failures AND when merely SOME files errored (permission
        // denied, sockets under --no-ignore --hidden) while the search itself
        // succeeded. Usable stdout distinguishes the two: keep the candidates
        // and surface partialReadErrors (never silently); reject only when
        // there is nothing usable so the caller falls back to the JS walk.
        if (execError && typeof execError.code === 'number' && execError.code > 1) {
          const candidatePaths = parseCandidates();
          if (execError.code === 2 && candidatePaths.size > 0) {
            resolve({ candidatePaths, partialReadErrors: true, truncated });
            return;
          }
          reject(buildError(`ripgrep exited with code ${execError.code}`));
          return;
        }
        resolve({ candidatePaths: parseCandidates(), partialReadErrors: false, truncated });
      }
    );
    // execFile cannot pass the Root's flock (an ADR-0017 limit); the host's supervisor still
    // learns this bounded search process.
    child.once('exit', trackNativeChild(child.pid, { group: false }));
  });
}

function normalizeRipgrepCandidatePath(value: string): string | null {
  const normalized = value.replace(/^\.\//, '').replaceAll('\\', '/');
  return normalized.length > 0 ? normalized : null;
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
    const normalized = normalizeRipgrepCandidatePath(event.data.path.text);
    if (normalized !== null) {
      paths.add(normalized);
    }
  }
  return paths;
}

function parseRipgrepFileCandidates(stdout: string): Set<string> {
  const paths = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const normalized = normalizeRipgrepCandidatePath(rawLine.replace(/\r$/, ''));
    if (normalized !== null) {
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
