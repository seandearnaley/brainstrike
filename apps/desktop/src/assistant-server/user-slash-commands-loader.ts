/**
 * User-defined slash command discovery (desktop / main-process only).
 *
 * Scans `*.md` command files from four location tiers, in PRIORITY order
 * (highest first, first-name-wins dedupe):
 *   1. `<root>/.brainstrike/commands/`   (every mounted root, in mounted order)
 *   2. `~/.brainstrike/commands/`
 *   3. `<root>/.claude/commands/`        (Claude Code compat)
 *   4. `~/.claude/commands/`
 *
 * brainstrike-native beats compat; project beats global; a cross-root collision
 * keeps the first (mounted order) + warns once per id (mirrors
 * use-file-mentions.ts's `warnedFallbackDropRootIds`). Directory nesting
 * namespaces the id (`git/commit.md` → `git:commit`). Malformed frontmatter is
 * skipped with a VISIBLE error (never a silent half-parse).
 *
 * The filesystem is dependency-injected so the tier/priority/collision logic is
 * unit-testable without touching disk.
 */

import {
  deriveUserCommandId,
  parseUserCommandFile,
  type UserSlashCommandDescriptor,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('UserSlashCommands');

const COMMANDS_SUBPATHS = {
  brainstrike: ['.brainstrike', 'commands'],
  claude: ['.claude', 'commands'],
} as const;

export interface UserSlashCommandScanRoot {
  /** Absolute filesystem path of the mounted root. */
  readonly absPath: string;
  /** The root's display name. */
  readonly displayName: string;
  /** The DB `roots.id` — the identity `@file` directives resolve against. */
  readonly id: string;
}

export interface UserSlashCommandDirEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly name: string;
}

/**
 * The outcome of reading one candidate command file. `oversized` is DISTINCT
 * from `unreadable` so the loader can log the HONEST reason: a real-disk reader
 * that pre-bounds a giant file reports `oversized` (a warn), never masquerading
 * as `unreadable` (an error "Failed to read"). Files under the reader's coarse
 * byte ceiling come back as `ok` and the loader applies the authoritative
 * character-cap check ({@link MAX_USER_COMMAND_FILE_CHARS}).
 */
export type UserSlashCommandReadResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: 'unreadable' | 'oversized' };

export interface UserSlashCommandScanDeps {
  /** List a directory's immediate entries; `null` when it is missing/unreadable. */
  readonly listDir: (absDir: string) => readonly UserSlashCommandDirEntry[] | null;
  /** Read a file's UTF-8 content, or a typed failure (`unreadable`/`oversized`). */
  readonly readFile: (absFile: string) => UserSlashCommandReadResult;
}

export interface UserSlashCommandScanInput {
  readonly homeDir: string;
  readonly roots: readonly UserSlashCommandScanRoot[];
}

const MD_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;

/**
 * Per-file template size cap. Command `.md` files are UNTRUSTED repo content, so
 * their bytes are bounded before they travel over IPC and into renderer memory
 * (mirrors the referenced-files / hook-context / write-cap idioms — every other
 * untrusted-content surface in the codebase is bounded). A prompt template
 * larger than this is not a prompt template; it is SKIPPED with a visible
 * warn-once, never silently truncated.
 */
export const MAX_USER_COMMAND_FILE_CHARS = 64_000;

/**
 * Coarse BYTE ceiling for the real-disk reader's pre-read stat guard. Set to
 * 4× the CHARACTER cap: the maximum UTF-8 byte length of a string of
 * {@link MAX_USER_COMMAND_FILE_CHARS} UTF-16 code units is ≤ 3 bytes/unit, so a
 * file at/under the character cap can NEVER exceed this byte ceiling (fixes the
 * earlier bytes-vs-chars false positive, where a multi-byte file under the char
 * cap was wrongly skipped). A file ABOVE this ceiling is DEFINITIVELY over the
 * character cap, so the reader reports it `oversized` without pulling its bytes
 * into the main process; everything under the ceiling is read and the loader
 * applies the authoritative character-cap check.
 */
export const MAX_USER_COMMAND_FILE_BYTES = MAX_USER_COMMAND_FILE_CHARS * 4;

/** Hard cap on the number of discovered commands per scan (abuse/DoS bound). */
export const MAX_USER_COMMANDS = 500;

/**
 * Maximum directory-nesting depth below a commands dir (P2-A). Namespacing is
 * `git/commit.md` → `git:commit`; nobody namespaces commands this deep, but a
 * hostile/accidental deep tree must not be walked with sync fs on Electron main.
 * Directories past the bound are SKIPPED with a visible warn-once.
 */
export const MAX_USER_COMMAND_SCAN_DEPTH = 8;

// App-lifetime warn-once per colliding id (mirrors use-file-mentions.ts) plus
// per-path oversized warnings and single count-cap/depth warnings. Reset in
// tests via __resetUserCommandWarningsForTests.
const warnedCollisionIds = new Set<string>();
const warnedOversizedPaths = new Set<string>();
let warnedCountCapReached = false;
let warnedDepthCapReached = false;

export function __resetUserCommandWarningsForTests(): void {
  warnedCollisionIds.clear();
  warnedOversizedPaths.clear();
  warnedCountCapReached = false;
  warnedDepthCapReached = false;
}

/** Warn ONCE per scan-lifetime that the command count cap stopped the scan. */
function warnCountCapReached(): void {
  if (warnedCountCapReached) {
    return;
  }
  warnedCountCapReached = true;
  logger.warn('User slash command count cap reached; ignoring the rest', {
    cap: MAX_USER_COMMANDS,
  });
}

function joinPath(base: string, segments: readonly string[]): string {
  return [base.replace(/\/+$/, ''), ...segments].join('/');
}

interface ScanSource {
  /** Owning root id for project-scoped tiers; undefined for global tiers. */
  readonly sourceRootId?: string;
}

/**
 * Mutable traversal budget threaded through the recursive collection (P2-A):
 * `remaining` candidate slots left; `truncated` flips when the budget stopped
 * traversal early (surfaced as the count-cap warn by the caller). Bounding the
 * TRAVERSAL — not just the accepted result — is the point: the scan runs
 * synchronous `readdirSync`/`statSync` on Electron main (and re-runs on
 * visibilitychange), so a hostile or huge tree must stop being WALKED at the
 * cap, never fully materialized first.
 */
interface TraversalBudget {
  remaining: number;
  truncated: boolean;
}

/**
 * Recursively collect `.md` files under `baseDir`, relative-namespaced, bounded
 * by `budget` (stops descending/collecting the moment it is exhausted) and by
 * {@link MAX_USER_COMMAND_SCAN_DEPTH} (deeper directories are skipped with a
 * warn-once). NOTE: when the budget truncates a directory, WHICH candidates were
 * collected follows enumeration order (the post-collection sort only orders the
 * bounded set) — acceptable for an abuse bound that normal trees never hit.
 */
function collectMarkdownFiles(
  baseDir: string,
  deps: UserSlashCommandScanDeps,
  budget: TraversalBudget,
  relativeSegments: readonly string[] = []
): { readonly absPath: string; readonly relativePath: string }[] {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return [];
  }
  const dirPath = relativeSegments.length > 0 ? joinPath(baseDir, relativeSegments) : baseDir;
  const entries = deps.listDir(dirPath);
  if (!entries) {
    return [];
  }
  const files: { absPath: string; relativePath: string }[] = [];
  for (const entry of entries) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    if (entry.isDirectory) {
      if (relativeSegments.length >= MAX_USER_COMMAND_SCAN_DEPTH) {
        if (!warnedDepthCapReached) {
          warnedDepthCapReached = true;
          logger.warn('User slash command scan depth cap reached; skipping deeper directories', {
            cap: MAX_USER_COMMAND_SCAN_DEPTH,
            path: joinPath(baseDir, [...relativeSegments, entry.name]),
          });
        }
        continue;
      }
      files.push(...collectMarkdownFiles(baseDir, deps, budget, [...relativeSegments, entry.name]));
      continue;
    }
    if (entry.isFile && MD_EXTENSION.test(entry.name)) {
      const relativePath = [...relativeSegments, entry.name].join('/');
      files.push({ absPath: joinPath(baseDir, [...relativeSegments, entry.name]), relativePath });
      budget.remaining -= 1;
    }
  }
  return files;
}

/** Warn once when a project-scoped cross-root id collision drops a later root. */
function warnCrossRootCollision(
  id: string,
  source: ScanSource,
  firstOwner: string | undefined
): void {
  if (
    source.sourceRootId &&
    firstOwner &&
    source.sourceRootId !== firstOwner &&
    !warnedCollisionIds.has(id)
  ) {
    warnedCollisionIds.add(id);
    logger.warn('Duplicate slash command id across roots; keeping the first-mounted root', {
      droppedRootId: source.sourceRootId,
      id,
      keptRootId: firstOwner,
    });
  }
}

/**
 * Read + parse one command file into a descriptor body (`name`/`description`/
 * `template`), or `null` when it is unreadable, oversized (F3), malformed, or an
 * empty template — each skipped with the appropriate visible log, never silently.
 */
/** Warn ONCE per path that a command file is skipped for exceeding the size cap. */
function warnOversized(absPath: string, chars: number | null): void {
  if (warnedOversizedPaths.has(absPath)) {
    return;
  }
  warnedOversizedPaths.add(absPath);
  logger.warn('Skipping oversized slash command file', {
    cap: MAX_USER_COMMAND_FILE_CHARS,
    // `chars` is null when the real-disk reader rejected the file by BYTE size
    // (over MAX_USER_COMMAND_FILE_BYTES) without reading it into memory.
    chars,
    path: absPath,
  });
}

function readCommandBody(
  file: { readonly absPath: string },
  deps: UserSlashCommandScanDeps
): { name?: string; description?: string; template: string } | null {
  const read = deps.readFile(file.absPath);
  if (!read.ok) {
    // Honest reason discrimination (F3 / review): a definitively-oversized file
    // pre-rejected by the reader is a WARN ("oversized"), never an ERROR
    // ("Failed to read") that misattributes the skip to an I/O failure.
    if (read.reason === 'oversized') {
      warnOversized(file.absPath, null);
    } else {
      logger.error('Failed to read slash command file', { path: file.absPath });
    }
    return null;
  }
  const content = read.content;
  if (content.length > MAX_USER_COMMAND_FILE_CHARS) {
    warnOversized(file.absPath, content.length);
    return null;
  }
  const parsed = parseUserCommandFile(content);
  if (!parsed.ok) {
    logger.error('Skipping malformed slash command file', {
      error: parsed.error,
      path: file.absPath,
    });
    return null;
  }
  if (parsed.template.trim().length === 0) {
    logger.debug('Skipping empty slash command template', { path: file.absPath });
    return null;
  }
  return parsed;
}

function ingestDirectory(
  baseDir: string,
  source: ScanSource,
  deps: UserSlashCommandScanDeps,
  seen: Map<string, string | undefined>,
  ordered: UserSlashCommandDescriptor[]
): void {
  const remaining = MAX_USER_COMMANDS - ordered.length;
  if (remaining <= 0) {
    warnCountCapReached();
    return;
  }
  // The budget counts CANDIDATES (bounding traversal work); candidates later
  // skipped as duplicates/malformed still consumed budget, so an adversarial
  // duplicate-heavy tree may yield fewer than the cap — the honest tradeoff for
  // never walking an unbounded tree (the truncation is warned either way).
  const budget: TraversalBudget = { remaining, truncated: false };
  const files = collectMarkdownFiles(baseDir, deps, budget);
  if (budget.truncated) {
    warnCountCapReached();
  }
  // Stable order within a directory so first-name-wins is deterministic.
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  for (const file of files) {
    if (ordered.length >= MAX_USER_COMMANDS) {
      warnCountCapReached();
      return;
    }
    const id = deriveUserCommandId(file.relativePath);
    if (id.length === 0) {
      continue;
    }
    if (seen.has(id)) {
      // A collision ACROSS roots in the same tier (both project-scoped) is the
      // meaningful one to surface; a lower-tier duplicate is expected precedence.
      warnCrossRootCollision(id, source, seen.get(id));
      continue;
    }

    const parsed = readCommandBody(file, deps);
    if (parsed === null) {
      continue;
    }

    seen.set(id, source.sourceRootId);
    ordered.push({
      id,
      label: parsed.name ?? id,
      template: parsed.template,
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(source.sourceRootId ? { sourceRootId: source.sourceRootId } : {}),
    });
  }
}

/**
 * Discover every user-defined slash command across the four location tiers.
 * Returns the deduped list in discovery (priority) order.
 */
export function scanUserSlashCommands(
  input: UserSlashCommandScanInput,
  deps: UserSlashCommandScanDeps
): UserSlashCommandDescriptor[] {
  const seen = new Map<string, string | undefined>();
  const ordered: UserSlashCommandDescriptor[] = [];

  // Tier 1: <root>/.brainstrike/commands (mounted order).
  for (const root of input.roots) {
    ingestDirectory(
      joinPath(root.absPath, COMMANDS_SUBPATHS.brainstrike),
      { sourceRootId: root.id },
      deps,
      seen,
      ordered
    );
  }
  // Tier 2: ~/.brainstrike/commands.
  ingestDirectory(joinPath(input.homeDir, COMMANDS_SUBPATHS.brainstrike), {}, deps, seen, ordered);
  // Tier 3: <root>/.claude/commands (mounted order).
  for (const root of input.roots) {
    ingestDirectory(
      joinPath(root.absPath, COMMANDS_SUBPATHS.claude),
      { sourceRootId: root.id },
      deps,
      seen,
      ordered
    );
  }
  // Tier 4: ~/.claude/commands.
  ingestDirectory(joinPath(input.homeDir, COMMANDS_SUBPATHS.claude), {}, deps, seen, ordered);

  return ordered;
}
