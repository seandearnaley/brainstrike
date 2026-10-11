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
import {
  buildUserPersona,
  MAX_USER_PERSONAS,
  resolveUserPersonaId,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type {
  UserSlashCommandDirEntry,
  UserSlashCommandReadResult,
  UserSlashCommandScanRoot,
} from './user-slash-commands-loader.js';

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
  | {
      /** The file that KEPT this id — the author's actual question is WHICH
       * file won, not merely which tier. Same shape as skill-scan's. */
      readonly shadowedBy: { readonly absPath: string; readonly sourceRootId?: string };
      readonly status: 'shadowed';
    }
);

export interface UserPersonaScanResult {
  /** Every discovered file in priority order (valid and invalid). */
  readonly entries: readonly UserPersonaScanEntry[];
  /**
   * Directories NOT fully scanned, with why. Both causes make personas
   * silently absent: 'listing-truncated' = more entries than the listing
   * bound; 'cap-reached' = the scan cap was exhausted before this directory
   * was read at all. The second matters most — an entries-based cap means a
   * root full of malformed files could otherwise starve `~/.brainstrike`
   * entirely, and one main-process log line is not "visible" (BST-936).
   */
  readonly incompleteDirs: readonly {
    readonly dir: string;
    readonly reason: 'cap-reached' | 'listing-truncated';
  }[];
  /** The valid personas, in priority order. */
  readonly personas: readonly AssistantPersonaDefinition[];
}

/**
 * Directory-listing request bound. DELIBERATELY larger than the persona cap:
 * `listDir`'s maxEntries counts EVERY directory entry (READMEs, subdirs,
 * backups, invalid files), so deriving it from the cap let junk evict real
 * personas from the listing before they were ever read (BST-936). Junk beyond
 * this bound surfaces in `truncatedDirs` rather than vanishing.
 */
const PERSONA_DIR_LISTING_BOUND = MAX_USER_PERSONAS * 2 + 1;

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

/** The file currently holding an id — reported to whoever it shadows. */
interface PersonaIdOwner {
  readonly absPath: string;
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
 *
 * The id is RESERVED from the FILENAME before the file is read or parsed.
 * A persona id is derived purely from its filename (`deriveUserPersonaId` —
 * the same contract function `buildUserPersona` uses, so the two can never
 * drift), which makes pre-parse reservation possible and load-bearing: a
 * BROKEN project-tier persona must block a same-named global one rather than
 * silently falling through to it. Without this, a project persona that fails
 * to parse quietly hands its name to a global file carrying entirely
 * different instructions (BST-936).
 *
 * A filename that cannot derive a valid id reserves nothing — there is no id
 * to hold, and a same-named file in a lower tier fails identically.
 */
function loadPersonaFile(
  fileName: string,
  baseDir: string,
  source: ScanSource,
  deps: UserPersonaScanDeps,
  seen: Map<string, PersonaIdOwner>
): UserPersonaScanEntry {
  const absPath = joinPath(baseDir, [fileName]);
  const sourceRootField = source.sourceRootId ? { sourceRootId: source.sourceRootId } : {};

  // Reserve through the FULL id gate (derivation + built-in collision), not
  // half of it: a file whose name collides with a BUILT-IN can never load in
  // any tier, so it must not reserve — otherwise the next same-named file is
  // mislabelled "shadowed by another file" when the real answer is "a
  // built-in owns this name", and both files deserve that accurate error.
  const resolved = resolveUserPersonaId(fileName);
  if (resolved.ok) {
    const owner = seen.get(resolved.value);
    if (owner) {
      warnCollision(resolved.value, source, owner.sourceRootId);
      return {
        absPath,
        fileName,
        shadowedBy: {
          absPath: owner.absPath,
          ...(owner.sourceRootId === undefined ? {} : { sourceRootId: owner.sourceRootId }),
        },
        status: 'shadowed',
        ...sourceRootField,
      };
    }
    seen.set(resolved.value, {
      absPath,
      ...(source.sourceRootId === undefined ? {} : { sourceRootId: source.sourceRootId }),
    });
  }

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

  return { absPath, fileName, persona: built.persona, status: 'ok', ...sourceRootField };
}

function ingestDirectory(
  baseDir: string,
  source: ScanSource,
  deps: UserPersonaScanDeps,
  seen: Map<string, PersonaIdOwner>,
  entries: UserPersonaScanEntry[],
  personas: AssistantPersonaDefinition[],
  incompleteDirs: { dir: string; reason: 'cap-reached' | 'listing-truncated' }[]
): void {
  // The cap counts ENTRIES (valid + invalid), not accepted personas: a
  // directory full of malformed files must consume the scan bound rather
  // than extend it across every mounted root (BST-936).
  const remaining = MAX_USER_PERSONAS_SCAN - entries.length;
  if (remaining <= 0) {
    // Reported, not merely logged: an entries-based cap means an earlier root
    // stuffed with malformed files can exhaust the budget before this
    // directory is read at all, and "my global personas vanished" must have a
    // visible cause.
    warnCountCapReached();
    incompleteDirs.push({ dir: baseDir, reason: 'cap-reached' });
    return;
  }
  const listing = deps.listDir(baseDir, source.containmentRoot, PERSONA_DIR_LISTING_BOUND);
  if (!listing) {
    return;
  }
  if (listing.truncated) {
    logger.warn('Persona directory listing truncated; later files were not scanned', {
      bound: PERSONA_DIR_LISTING_BOUND,
      dir: baseDir,
    });
    incompleteDirs.push({ dir: baseDir, reason: 'listing-truncated' });
  }
  const fileNames = listing.entries
    .filter((entry) => entry.isFile && MD_EXTENSION.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of fileNames) {
    if (entries.length >= MAX_USER_PERSONAS_SCAN) {
      warnCountCapReached();
      incompleteDirs.push({ dir: baseDir, reason: 'cap-reached' });
      return;
    }
    const entry = loadPersonaFile(fileName, baseDir, source, deps, seen);
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
  const seen = new Map<string, PersonaIdOwner>();
  const entries: UserPersonaScanEntry[] = [];
  const personas: AssistantPersonaDefinition[] = [];
  const incompleteDirs: { dir: string; reason: 'cap-reached' | 'listing-truncated' }[] = [];

  // Tier 1: <root>/.brainstrike/agents (mounted order).
  for (const root of input.roots) {
    ingestDirectory(
      joinPath(root.absPath, AGENTS_SUBPATH),
      { containmentRoot: root.absPath, sourceRootId: root.id },
      deps,
      seen,
      entries,
      personas,
      incompleteDirs
    );
  }
  // Tier 2: ~/.brainstrike/agents.
  ingestDirectory(
    joinPath(input.homeDir, AGENTS_SUBPATH),
    { containmentRoot: input.homeDir },
    deps,
    seen,
    entries,
    personas,
    incompleteDirs
  );

  return { entries, incompleteDirs, personas };
}
