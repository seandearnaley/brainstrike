/**
 * User-defined persona discovery (desktop / main-process only).
 *
 * Scans `*.md` persona files from two location tiers, in PRIORITY order
 * (highest first, first-id-wins dedupe):
 *   1. `<root>/.brainstrike/agents/`   (every mounted root, in mounted order)
 *   2. `~/.brainstrike/agents/`
 *
 * The scan is FLAT (no directory recursion): a persona id becomes the
 * `agent-<id>` delegation tool name, and provider tool-name charsets forbid the
 * ':' namespacing separator commands use. Subdirectories are ignored.
 *
 * Every discovered file lands in `entries` — valid files as `status: 'ok'`
 * (with the built persona) and broken files as `status: 'invalid'` with the
 * parse/validation error, so the settings panel can show authors exactly why a
 * persona did not load (fail closed, never silent). `personas` is the ordered
 * valid subset.
 *
 * The filesystem is dependency-injected (same shape as the slash-commands
 * loader) so tier/priority/collision logic is unit-testable without disk.
 */

import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract';
import { buildUserPersona, MAX_USER_PERSONAS } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';
import type {
  UserSlashCommandDirEntry,
  UserSlashCommandReadResult,
  UserSlashCommandScanRoot,
} from './user-slash-commands-loader';

const logger = createLogger('UserPersonas');

const AGENTS_SUBPATH = ['.brainstrike', 'agents'] as const;

const MD_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;

/** Hard cap on accepted personas per scan (abuse/DoS bound). */
export const MAX_USER_PERSONAS_SCAN = MAX_USER_PERSONAS;

/** Same injected-fs shape as the slash-commands loader (structural reuse). */
export interface UserPersonaScanDeps {
  readonly listDir: (
    absDir: string,
    containmentRoot: string,
    maxEntries: number
  ) => {
    readonly entries: readonly UserSlashCommandDirEntry[];
    readonly inspected: number;
    readonly truncated: boolean;
  } | null;
  readonly readFile: (absFile: string) => UserSlashCommandReadResult;
}

export interface UserPersonaScanInput {
  readonly homeDir: string;
  readonly roots: readonly UserSlashCommandScanRoot[];
}

/** One discovered persona file, valid or not — the settings panel lists both. */
export type UserPersonaScanEntry = {
  readonly absPath: string;
  readonly fileName: string;
  /** Owning root id for project-scoped personas; absent for `~` (global). */
  readonly sourceRootId?: string;
} & (
  | { readonly persona: AssistantPersonaDefinition; readonly status: 'ok' }
  | { readonly error: string; readonly status: 'invalid' }
);

export interface UserPersonaScanResult {
  /** Every discovered file in priority order (valid and invalid). */
  readonly entries: readonly UserPersonaScanEntry[];
  /** The valid personas, in priority order. */
  readonly personas: readonly AssistantPersonaDefinition[];
}

// App-lifetime warn-once sets (mirrors the slash-commands loader).
const warnedCollisionIds = new Set<string>();
let warnedCountCapReached = false;

export function __resetUserPersonaWarningsForTests(): void {
  warnedCollisionIds.clear();
  warnedCountCapReached = false;
}

function warnCountCapReached(): void {
  if (warnedCountCapReached) {
    return;
  }
  warnedCountCapReached = true;
  logger.warn('User persona count cap reached; ignoring the rest', {
    cap: MAX_USER_PERSONAS_SCAN,
  });
}

function joinPath(base: string, segments: readonly string[]): string {
  return [base.replace(/\/+$/, ''), ...segments].join('/');
}

interface ScanSource {
  readonly containmentRoot: string;
  readonly sourceRootId?: string;
}

function warnCollision(id: string, source: ScanSource, firstOwner: string | undefined): void {
  if (warnedCollisionIds.has(id)) {
    return;
  }
  warnedCollisionIds.add(id);
  logger.warn('Duplicate persona id; keeping the first-discovered persona', {
    droppedRootId: source.sourceRootId,
    id,
    keptRootId: firstOwner,
  });
}

/**
 * Read + build one candidate persona file into a scan entry, or `null` for a
 * DUPLICATE id (first-wins, warned) — the only outcome that produces no entry.
 */
function loadPersonaFile(
  fileName: string,
  baseDir: string,
  source: ScanSource,
  deps: UserPersonaScanDeps,
  seen: Map<string, string | undefined>
): UserPersonaScanEntry | null {
  const absPath = joinPath(baseDir, [fileName]);
  const sourceRootField = source.sourceRootId ? { sourceRootId: source.sourceRootId } : {};

  const read = deps.readFile(absPath);
  if (!read.ok) {
    const error =
      read.reason === 'oversized'
        ? 'persona file exceeds the size cap'
        : 'failed to read persona file';
    logger.warn('Skipping unreadable persona file', { path: absPath, reason: read.reason });
    return { absPath, error, fileName, status: 'invalid', ...sourceRootField };
  }

  const built = buildUserPersona({ content: read.content, fileName });
  if (!built.ok) {
    logger.warn('Skipping invalid persona file', { error: built.error, path: absPath });
    return { absPath, error: built.error, fileName, status: 'invalid', ...sourceRootField };
  }

  const id = built.persona.id;
  if (seen.has(id)) {
    warnCollision(id, source, seen.get(id));
    return null;
  }
  seen.set(id, source.sourceRootId);
  return { absPath, fileName, persona: built.persona, status: 'ok', ...sourceRootField };
}

function ingestDirectory(
  baseDir: string,
  source: ScanSource,
  deps: UserPersonaScanDeps,
  seen: Map<string, string | undefined>,
  entries: UserPersonaScanEntry[],
  personas: AssistantPersonaDefinition[]
): void {
  const remaining = MAX_USER_PERSONAS_SCAN - personas.length;
  if (remaining <= 0) {
    warnCountCapReached();
    return;
  }
  const listing = deps.listDir(baseDir, source.containmentRoot, remaining + 1);
  if (!listing) {
    return;
  }
  const fileNames = listing.entries
    .filter((entry) => entry.isFile && MD_EXTENSION.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of fileNames) {
    if (personas.length >= MAX_USER_PERSONAS_SCAN) {
      warnCountCapReached();
      return;
    }
    const entry = loadPersonaFile(fileName, baseDir, source, deps, seen);
    if (entry === null) {
      continue;
    }
    entries.push(entry);
    if (entry.status === 'ok') {
      personas.push(entry.persona);
    }
  }
}

/**
 * Discover every user-defined persona across the two location tiers. Returns
 * valid personas plus the full entry list (valid + invalid) in priority order.
 */
export function scanUserPersonas(
  input: UserPersonaScanInput,
  deps: UserPersonaScanDeps
): UserPersonaScanResult {
  const seen = new Map<string, string | undefined>();
  const entries: UserPersonaScanEntry[] = [];
  const personas: AssistantPersonaDefinition[] = [];

  // Tier 1: <root>/.brainstrike/agents (mounted order).
  for (const root of input.roots) {
    ingestDirectory(
      joinPath(root.absPath, AGENTS_SUBPATH),
      { containmentRoot: root.absPath, sourceRootId: root.id },
      deps,
      seen,
      entries,
      personas
    );
  }
  // Tier 2: ~/.brainstrike/agents.
  ingestDirectory(
    joinPath(input.homeDir, AGENTS_SUBPATH),
    { containmentRoot: input.homeDir },
    deps,
    seen,
    entries,
    personas
  );

  return { entries, personas };
}
