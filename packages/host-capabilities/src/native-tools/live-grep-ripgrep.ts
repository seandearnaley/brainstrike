/**
 * The ripgrep execution layer of the LIVE grep pass: the bundled binary,
 * argument construction (including the policy-derived prune globs), the bounded
 * streaming spawn, and candidate parsing. Split from `live-grep.ts` (BST-1246),
 * which owns candidate resolution, matching, the excluded-path probe and the
 * streaming search itself.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import { endTreeOnDeadline, trackNativeChild } from '@brainstrike/state-store/native-children';
import {
  BALANCED_UNCONDITIONAL_EXCLUDED_DIRECTORY_SEGMENTS,
  UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES,
  WORKSPACE_SECRET_FILE_PATTERNS,
} from '@brainstrike/utils';
import { extractTrigramLiteral } from '@brainstrike/utils/grep-pattern';
import { rgPath } from '@vscode/ripgrep';

const logger = createLogger('LiveGrepRipgrep');

let credentialFloorFile: string | undefined;

/**
 * One floor pattern, matched without case as the JS matcher (`ignore`) matches
 * it: rg reads ignore files case-sensitively, and its
 * `--ignore-file-case-insensitive` would make the workspace's own ignore files
 * caseless too. Each letter becomes a two-case class, so a pattern that brings
 * its own class cannot be rewritten here.
 */
function caselessIgnorePattern(pattern: string): string {
  if (pattern.includes('[')) {
    throw new Error(`The credential floor pattern "${pattern}" cannot be made caseless for rg`);
  }
  return pattern.replace(
    /[a-z]/giu,
    (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`
  );
}

/**
 * The shared credential floor as a gitignore-syntax file for ripgrep's
 * `--ignore-file`, so rg never opens a credential file nor spends its candidate
 * cap on one before the JS matcher drops it. `--glob` cannot carry the floor's
 * template re-includes (a positive glob turns rg into a whitelist), and
 * `--no-ignore` does not disable `--ignore-file`. Written once per process
 * inside a directory `mkdtemp` created for it (owner-only), with exclusive
 * create, so no path another local user could predict or pre-plant a symlink
 * at is ever written.
 */
function credentialFloorIgnoreFile(): string {
  if (credentialFloorFile !== undefined) {
    return credentialFloorFile;
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-credential-floor-'));
  const file = path.join(directory, 'floor.ignore');
  const patterns = WORKSPACE_SECRET_FILE_PATTERNS.map(caselessIgnorePattern);
  writeFileSync(file, `${patterns.join('\n')}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  credentialFloorFile = file;
  return file;
}

/** Wall-clock bound for one ripgrep run (per root). */
const RIPGREP_TIMEOUT_MS = 4000;
/** Shorter per-root ripgrep ceiling for the optional excluded-path probe. */
export const PROBE_RIPGREP_TIMEOUT_MS = 1500;
/** Cap on ripgrep stdout (~bytes) so a pathological match set can't blow memory. */
const RIPGREP_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Skip files larger than this in the prefilter (mirrors the read bound). */
const RIPGREP_MAX_FILESIZE = '2M';
/** Per-file match cap in the prefilter — we only need candidacy, not every hit. */
const RIPGREP_MAX_COUNT_PER_FILE = 200;

const ASAR_SEGMENT = `${path.sep}app.asar${path.sep}`;
const UNPACKED_SEGMENT = `${path.sep}app.asar.unpacked${path.sep}`;

/**
 * The bundled ripgrep (`@vscode/ripgrep`, one optional package per platform).
 * Inside a packaged desktop app it resolves through `app.asar`, a virtual path
 * a spawned process cannot execute; electron-builder's `asarUnpack` writes the
 * real binary to `app.asar.unpacked`. One deterministic mapping and no PATH
 * search: a missing binary means the install or packaging is wrong, so this
 * throws instead of searching some other way.
 */
export function bundledRipgrepPath(resolved: string = rgPath): string {
  if (!resolved.includes(ASAR_SEGMENT)) {
    return resolved;
  }
  const unpacked = resolved.replace(ASAR_SEGMENT, UNPACKED_SEGMENT);
  if (!existsSync(unpacked)) {
    throw new Error(
      `ripgrep is not asarUnpacked: ${unpacked} does not exist. Add the @vscode/ripgrep platform package's binary to electron-builder asarUnpack.`
    );
  }
  return unpacked;
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
 * literal). The caller MUST NOT hand the raw regex to ripgrep then (Rust's regex
 * dialect can match a NARROWER set than JS `RegExp`, silently dropping files);
 * it lists every eligible file with ripgrep instead and matches each in JS.
 */
export function resolveRipgrepPrefilterLiteral(args: {
  pattern: string;
  isRegex: boolean;
}): string | null {
  return args.isRegex ? extractTrigramLiteral(args.pattern) : args.pattern;
}

/**
 * BST-1246: non-sensitive metadata describing WHY an rg run failed. A spawn
 * error can embed the spawned command (including the search pattern), so it
 * stays redacted; these fields carry no user content and make the failure
 * class observable from diagnostics.
 */
export interface RipgrepFailureMetadata {
  readonly elapsedMs: number;
  /** Node error-code string (e.g. ENOENT) when the failure was not an exit code. */
  readonly errorCode: string | null;
  /** Numeric rg exit code when the process exited on its own. */
  readonly exitCode: number | null;
  readonly killed: boolean;
  readonly signal: string | null;
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

/**
 * What one ripgrep run emits per line:
 * - `matches`: `--json` begin events, one per file holding the literal;
 * - `files-with-matches`: one path per file holding the literal (the probe);
 * - `files`: every file ripgrep would search, for a regex with no literal.
 */
export type RipgrepMode = 'files' | 'files-with-matches' | 'matches';

/** Build the ripgrep argument list for one run. */
function buildRipgrepArgs(args: {
  mode: RipgrepMode;
  /** The fixed-string literal; absent only in `files` mode. */
  prefilterLiteral?: string | undefined;
  caseSensitive: boolean;
  /**
   * Apply the balanced-policy directory prune (default true; ~27 policy
   * globs plus the `.claude/worktrees` prefix). The excluded-path probe
   * passes false because its PURPOSE is to search policy-excluded trees
   * (only `.git` stays pruned there).
   */
  applyPolicyPrune?: boolean | undefined;
}): string[] {
  const modeArgs: Record<RipgrepMode, readonly string[]> = {
    files: ['--files'],
    'files-with-matches': ['--files-with-matches', '--max-count=1'],
    matches: ['--json', `--max-count=${RIPGREP_MAX_COUNT_PER_FILE}`],
  };
  const rgArgs = [
    ...modeArgs[args.mode],
    '--no-config',
    '--no-follow',
    // The balanced entry policy (re-applied to every candidate) is the SINGLE
    // source of truth for exclusions, so disable ripgrep's own
    // .gitignore/.ignore/.rgignore and hidden-file filtering. `--no-ignore`
    // already implies --no-ignore-global/--no-ignore-parent/--no-ignore-vcs.
    // (`.git` is still hard-excluded and realpath-containment-checked per
    // candidate.)
    '--no-ignore',
    '--hidden',
    // Treat EVERY file as text. By default rg's content heuristic skips any file
    // with a NUL byte before the first match, but brainstrike's exclusion
    // authority (`isBinaryFile`, the entry policy) is EXTENSION-based: a
    // `.ts`/`.md`/`.json` file with a NUL byte (UTF-16 content, an embedded blob,
    // a partial save) is INCLUDED by the policy and read as utf8 by the
    // authoritative matcher. Without `--text` rg would drop exactly those files.
    '--text',
    `--max-filesize=${RIPGREP_MAX_FILESIZE}`,
    // The credential floor binds rg itself, in every mode, including the
    // excluded-path probe: it is beneath every layer, never re-includable.
    `--ignore-file=${credentialFloorIgnoreFile()}`,
  ];
  // Prune the directories the entry policy excludes UNCONDITIONALLY by name at
  // ANY depth. `--no-ignore --hidden` would otherwise make rg DESCEND into them:
  // artifact trees (.vite sourcemaps, dist, .turbo, coverage, node_modules)
  // blew the time budget on real repos (BST-1246), and rg emits in traversal
  // order, so the output cap could fill with policy-filtered-to-nothing
  // artifact candidates while real src/ matches fell off the end. These globs
  // prune ONLY dirs the balanced policy hard-excludes by name, so the candidate
  // set stays a strict SUPERSET of policy-kept files. The excluded-path probe's
  // PURPOSE is to find matches inside policy-excluded paths, so it keeps
  // everything except `.git` searchable.
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
  if (args.mode === 'files') {
    rgArgs.push('--', '.');
    return rgArgs;
  }
  // Always fixed-strings: rg is a literal SUPERSET prefilter only; the
  // authoritative literal/regex match is re-derived by the shared JS matcher.
  rgArgs.push('--fixed-strings', args.caseSensitive ? '--case-sensitive' : '--ignore-case');
  // `--` terminates options so a literal starting with `-` is not parsed as a flag.
  rgArgs.push('--', args.prefilterLiteral ?? '', '.');
  return rgArgs;
}

/** How one ripgrep run ended once its output was read. */
export interface RipgrepOutcome {
  /**
   * BST-1246: rg exited 2 (some files errored: permission denied, sockets) but
   * still produced usable candidates. The candidates are kept — files rg could
   * not read would be equally unreadable to the authoritative JS matcher — and
   * the condition is surfaced in the live note, never silently.
   */
  partialReadErrors: boolean;
  /** The consumer stopped the run (its candidate cap was reached). */
  stopped: boolean;
  /** ripgrep reached its time budget; the candidates it emitted were kept. */
  timedOut: boolean;
  /** True when the output cap ended the run: the candidate set is partial. */
  truncated: boolean;
}

/** A running ripgrep: candidate paths stream to `onPath` as rg prints them. */
export interface RipgrepStream {
  readonly done: Promise<RipgrepOutcome>;
  /** Ends rg early; `done` then resolves with `stopped`. */
  stop(): void;
}

export interface RipgrepRunOptions {
  applyPolicyPrune?: boolean | undefined;
  canonicalRootPath: string;
  caseSensitive: boolean;
  mode: RipgrepMode;
  prefilterLiteral?: string | undefined;
  ripgrepPath: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

function normalizeRipgrepCandidatePath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  return normalized.length > 0 ? normalized : null;
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

/** The workspace-relative candidate path one line of rg output names, if any. */
function candidateFromLine(line: string, mode: RipgrepMode): string | null {
  const trimmed = line.replace(/\r$/u, '');
  if (trimmed.length === 0) {
    return null;
  }
  if (mode !== 'matches') {
    return normalizeRipgrepCandidatePath(trimmed);
  }
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isRipgrepBeginEvent(event) ? normalizeRipgrepCandidatePath(event.data.path.text) : null;
}

/**
 * How one ripgrep run ended. Our own stop, output cap or time budget keeps what
 * it printed. rg exit 1 means "no matches". Exit 2 arrives both for
 * catastrophic failures AND when merely SOME files errored (permission denied,
 * sockets under --no-ignore --hidden) while the search itself succeeded;
 * usable output distinguishes the two. An external SIGKILL/SIGTERM (OOM
 * killer, app shutdown) is not ours, and stays a visible failure.
 */
function ripgrepExitVerdict(exit: {
  code: number | null;
  emitted: number;
  endedByUs: boolean;
  exitSignal: NodeJS.Signals | null;
  externallyAborted: boolean;
  spawnError: NodeJS.ErrnoException | undefined;
}): { ok: true; partialReadErrors: boolean } | { ok: false; reason: string } {
  if (exit.spawnError) {
    return {
      ok: false,
      reason: `ripgrep could not start (${exit.spawnError.code ?? 'unknown error'})`,
    };
  }
  if (exit.externallyAborted) {
    return { ok: false, reason: 'ripgrep aborted' };
  }
  if (exit.endedByUs) {
    return { ok: true, partialReadErrors: false };
  }
  if (exit.exitSignal !== null) {
    return { ok: false, reason: `ripgrep terminated by ${exit.exitSignal}` };
  }
  if (exit.code === 0 || exit.code === 1) {
    return { ok: true, partialReadErrors: false };
  }
  if (exit.code === 2 && exit.emitted > 0) {
    return { ok: true, partialReadErrors: true };
  }
  return { ok: false, reason: `ripgrep exited with code ${exit.code ?? 'unknown'}` };
}

/**
 * Spawn ripgrep in `canonicalRootPath` and stream each candidate path to
 * `onPath` the moment rg prints it, so a caller can match and show the first
 * file while rg is still walking. ripgrep is the FAST disk prefilter only, run
 * on a fixed-string SUPERSET literal (never a raw regex) or as a plain file
 * listing; the authoritative match (and final ignore/containment filtering) is
 * re-derived in JS, so ripgrep's match dialect can never diverge the results.
 * Bounded by its time budget, max-filesize, max-count and output cap. A spawn
 * failure, an abort or an exit other than 0, 1 or a partial 2 rejects with a
 * pattern-free {@link RipgrepRunError}; a timeout or output cap resolves with
 * the candidates already streamed and says so.
 */
export function streamRipgrep(
  args: RipgrepRunOptions,
  onPath: (relativePath: string) => void
): RipgrepStream {
  const timeoutMs = args.timeoutMs ?? RIPGREP_TIMEOUT_MS;
  const startedAt = Date.now();
  const stopper = new AbortController();
  const signal = args.signal ? AbortSignal.any([args.signal, stopper.signal]) : stopper.signal;
  const child = spawn(args.ripgrepPath, buildRipgrepArgs(args), {
    cwd: args.canonicalRootPath,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  // A spawned process cannot pass the Root's flock (an ADR-0017 limit); the
  // host's supervisor still learns this bounded search process.
  child.once('spawn', () => {
    child.once('exit', trackNativeChild(child.pid, { group: false }));
  });
  // The timeout, the abort and a stop end rg's whole tree.
  const deadline = endTreeOnDeadline(child, {
    onError: (cause) => logger.warn('Could not end the ripgrep process tree', { cause }),
    signal,
    timeoutMs,
  });
  let emitted = 0;
  let outputBytes = 0;
  let truncated = false;
  let pending = '';
  const emit = (line: string): void => {
    const candidate = candidateFromLine(line, args.mode);
    if (candidate !== null) {
      emitted += 1;
      onPath(candidate);
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (truncated || stopper.signal.aborted) {
      return;
    }
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > RIPGREP_MAX_OUTPUT_BYTES) {
      truncated = true;
      stopper.abort();
      return;
    }
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      emit(line);
      if (stopper.signal.aborted) {
        return;
      }
    }
  });
  const done = new Promise<RipgrepOutcome>((resolve, reject) => {
    let spawnError: NodeJS.ErrnoException | undefined;
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.once('close', (code: number | null, exitSignal: NodeJS.Signals | null) => {
      deadline.clear();
      if (!(truncated || stopper.signal.aborted) && pending.length > 0) {
        emit(pending);
      }
      const verdict = ripgrepExitVerdict({
        code,
        emitted,
        endedByUs: stopper.signal.aborted || deadline.timedOut,
        exitSignal,
        externallyAborted: args.signal?.aborted === true,
        spawnError,
      });
      if (verdict.ok) {
        resolve({
          partialReadErrors: verdict.partialReadErrors,
          stopped: stopper.signal.aborted && !truncated,
          timedOut: deadline.timedOut,
          truncated,
        });
        return;
      }
      reject(
        new RipgrepRunError(verdict.reason, {
          elapsedMs: Date.now() - startedAt,
          errorCode: typeof spawnError?.code === 'string' ? spawnError.code : null,
          exitCode: code,
          killed: deadline.ended,
          signal: exitSignal,
        })
      );
    });
  });
  return { done, stop: () => stopper.abort() };
}

/** One ripgrep run's candidate paths, collected; see {@link streamRipgrep}. */
export async function runRipgrep(
  args: RipgrepRunOptions
): Promise<RipgrepOutcome & { candidatePaths: Set<string> }> {
  const candidatePaths = new Set<string>();
  const outcome = await streamRipgrep(args, (relativePath) => {
    candidatePaths.add(relativePath);
  }).done;
  return { ...outcome, candidatePaths };
}
