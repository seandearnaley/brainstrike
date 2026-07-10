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

export interface UserSlashCommandScanDeps {
  /** List a directory's immediate entries; `null` when it is missing/unreadable. */
  readonly listDir: (absDir: string) => readonly UserSlashCommandDirEntry[] | null;
  /** Read a file's UTF-8 content; `null` when it is missing/unreadable. */
  readonly readFile: (absFile: string) => string | null;
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

/** Hard cap on the number of discovered commands per scan (abuse/DoS bound). */
export const MAX_USER_COMMANDS = 500;

// App-lifetime warn-once per colliding id (mirrors use-file-mentions.ts) plus
// per-path oversized warnings and a single count-cap warning. Reset in tests via
// __resetUserCommandWarningsForTests.
const warnedCollisionIds = new Set<string>();
const warnedOversizedPaths = new Set<string>();
let warnedCountCapReached = false;

export function __resetUserCommandWarningsForTests(): void {
  warnedCollisionIds.clear();
  warnedOversizedPaths.clear();
  warnedCountCapReached = false;
}

function joinPath(base: string, segments: readonly string[]): string {
  return [base.replace(/\/+$/, ''), ...segments].join('/');
}

interface ScanSource {
  /** Owning root id for project-scoped tiers; undefined for global tiers. */
  readonly sourceRootId?: string;
}

/** Recursively collect `.md` files under `baseDir`, relative-namespaced. */
function collectMarkdownFiles(
  baseDir: string,
  deps: UserSlashCommandScanDeps,
  relativeSegments: readonly string[] = []
): { readonly absPath: string; readonly relativePath: string }[] {
  const dirPath = relativeSegments.length > 0 ? joinPath(baseDir, relativeSegments) : baseDir;
  const entries = deps.listDir(dirPath);
  if (!entries) {
    return [];
  }
  const files: { absPath: string; relativePath: string }[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      files.push(...collectMarkdownFiles(baseDir, deps, [...relativeSegments, entry.name]));
      continue;
    }
    if (entry.isFile && MD_EXTENSION.test(entry.name)) {
      const relativePath = [...relativeSegments, entry.name].join('/');
      files.push({ absPath: joinPath(baseDir, [...relativeSegments, entry.name]), relativePath });
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
function readCommandBody(
  file: { readonly absPath: string },
  deps: UserSlashCommandScanDeps
): { name?: string; description?: string; template: string } | null {
  const content = deps.readFile(file.absPath);
  if (content === null) {
    logger.error('Failed to read slash command file', { path: file.absPath });
    return null;
  }
  if (content.length > MAX_USER_COMMAND_FILE_CHARS) {
    if (!warnedOversizedPaths.has(file.absPath)) {
      warnedOversizedPaths.add(file.absPath);
      logger.warn('Skipping oversized slash command file', {
        cap: MAX_USER_COMMAND_FILE_CHARS,
        chars: content.length,
        path: file.absPath,
      });
    }
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

/** Whether the count cap is reached (warn-once on the first time it trips). */
function isCountCapReached(ordered: readonly UserSlashCommandDescriptor[]): boolean {
  if (ordered.length < MAX_USER_COMMANDS) {
    return false;
  }
  if (!warnedCountCapReached) {
    warnedCountCapReached = true;
    logger.warn('User slash command count cap reached; ignoring the rest', {
      cap: MAX_USER_COMMANDS,
    });
  }
  return true;
}

function ingestDirectory(
  baseDir: string,
  source: ScanSource,
  deps: UserSlashCommandScanDeps,
  seen: Map<string, string | undefined>,
  ordered: UserSlashCommandDescriptor[]
): void {
  const files = collectMarkdownFiles(baseDir, deps);
  // Stable order within a directory so first-name-wins is deterministic.
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  for (const file of files) {
    if (isCountCapReached(ordered)) {
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
