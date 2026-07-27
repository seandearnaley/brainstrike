/**
 * Lens discovery (desktop / main-process only) — BST-921.
 *
 * Scans `*.sql` lens files from two location tiers, in PRIORITY order
 * (highest first, first-id-wins dedupe), MIRRORING user-personas-loader.ts —
 * deliberately the same convention rather than a third one:
 *   1. `<root>/.brainstrike/lenses/`   (every mounted root, in mounted order)
 *   2. `~/.brainstrike/lenses/`
 *
 * The scan is FLAT (no directory recursion): a lens id is the filename stem,
 * invoked by name through `brainstrike.querySelf`, and the id charset forbids
 * namespacing separators. Subdirectories are ignored.
 *
 * Every discovered file lands in `entries` — valid files as `status: 'ok'`
 * (with the parsed lens) and broken files as `status: 'invalid'` with the
 * parse error, so `mode: 'listLenses'` shows authors exactly why a lens did
 * not load (fail closed, never silent). `lenses` is the ordered valid subset.
 *
 * The filesystem is dependency-injected (same shape as the slash-commands
 * loader) so tier/priority/collision logic is unit-testable without disk.
 */

import type { LensDefinition } from '@brainstrike/assistant-contract';
import {
  deriveLensId,
  MAX_USER_LENSES,
  parseLensFile,
  USER_LENS_DIRNAME,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';
import type {
  UserSlashCommandDirEntry,
  UserSlashCommandReadResult,
  UserSlashCommandScanRoot,
} from './user-slash-commands-loader';

const logger = createLogger('UserLenses');

const LENSES_SUBPATH = ['.brainstrike', USER_LENS_DIRNAME] as const;

const SQL_EXTENSION = /\.sql$/i;

/** Hard cap on accepted lenses per scan (abuse/DoS bound). */
export const MAX_USER_LENSES_SCAN = MAX_USER_LENSES;

/** Same injected-fs shape as the slash-commands/persona loaders. */
export interface UserLensScanDeps {
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

export interface UserLensScanInput {
  readonly homeDir: string;
  readonly roots: readonly UserSlashCommandScanRoot[];
}

/** One discovered lens file, valid or not — listLenses shows both. */
export type UserLensScanEntry = {
  readonly absPath: string;
  readonly fileName: string;
  /** Owning root id for project-scoped lenses; absent for `~` (global). */
  readonly sourceRootId?: string;
} & (
  | { readonly lens: LensDefinition; readonly status: 'ok' }
  | { readonly error: string; readonly status: 'invalid' }
  | {
      /** The file that KEPT this id (skill-scan / persona-loader shape). */
      readonly shadowedBy: { readonly absPath: string; readonly sourceRootId?: string };
      readonly status: 'shadowed';
    }
);

export interface UserLensScanResult {
  /** Every discovered file in priority order (valid and invalid). */
  readonly entries: readonly UserLensScanEntry[];
  /**
   * Directories NOT fully scanned, with why — same shape and rationale as the
   * persona loader (BST-936): 'cap-reached' means the budget was exhausted
   * before this directory was read at all.
   */
  readonly incompleteDirs: readonly {
    readonly dir: string;
    readonly reason: 'cap-reached' | 'listing-truncated';
  }[];
  /** The valid lenses, in priority order. */
  readonly lenses: readonly LensDefinition[];
}

/**
 * Directory-listing request bound. DELIBERATELY larger than the lens cap:
 * `listDir`'s maxEntries counts every directory entry (READMEs, subdirs,
 * backups), so a bound equal to the cap would let junk files evict real
 * lenses from the listing before they were ever read. Junk beyond this bound
 * surfaces in `truncatedDirs` rather than vanishing.
 */
const LENS_DIR_LISTING_BOUND = MAX_USER_LENSES * 2 + 1;

// App-lifetime warn-once sets (mirrors the persona loader).
const warnedCollisionIds = new Set<string>();
let warnedCountCapReached = false;

export function __resetUserLensWarningsForTests(): void {
  warnedCollisionIds.clear();
  warnedCountCapReached = false;
}

function warnCountCapReached(): void {
  if (warnedCountCapReached) {
    return;
  }
  warnedCountCapReached = true;
  logger.warn('User lens count cap reached; ignoring the rest', {
    cap: MAX_USER_LENSES_SCAN,
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
interface LensIdOwner {
  readonly absPath: string;
  readonly sourceRootId?: string;
}

function warnCollision(id: string, source: ScanSource, firstOwner: string | undefined): void {
  if (warnedCollisionIds.has(id)) {
    return;
  }
  warnedCollisionIds.add(id);
  logger.warn('Duplicate lens id; keeping the first-discovered lens', {
    droppedRootId: source.sourceRootId,
    id,
    keptRootId: firstOwner,
  });
}

/**
 * Read + parse one candidate lens file into a scan entry, or `null` for a
 * DUPLICATE id (first-wins, warned) — the only outcome that produces no entry.
 *
 * The id is RESERVED from the filename BEFORE reading or parsing (a lens id
 * IS its filename stem, so it is known up front — unlike personas, whose id
 * comes from frontmatter). This is load-bearing: a BROKEN project-tier lens
 * must block a same-named global lens rather than silently falling through
 * to it — a fallback would swap in different SQL under the id the author
 * thinks they control (#2034 review, P1). The invalid entry keeps the id's
 * slot, and invoking it surfaces the project file's parse error.
 */
function loadLensFile(
  fileName: string,
  baseDir: string,
  source: ScanSource,
  deps: UserLensScanDeps,
  seen: Map<string, LensIdOwner>
): UserLensScanEntry {
  const absPath = joinPath(baseDir, [fileName]);
  const sourceRootField = source.sourceRootId ? { sourceRootId: source.sourceRootId } : {};

  // The SAME derivation the parser uses (contract-owned), so the reserved key
  // and the parsed lens id can never disagree. A filename that derives no
  // valid id reserves nothing — a same-named file lower down fails identically.
  const derived = deriveLensId(fileName);
  if (derived.ok) {
    const owner = seen.get(derived.id);
    if (owner) {
      warnCollision(derived.id, source, owner.sourceRootId);
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
    seen.set(derived.id, {
      absPath,
      ...(source.sourceRootId === undefined ? {} : { sourceRootId: source.sourceRootId }),
    });
  }

  const read = deps.readFile(absPath);
  if (!read.ok) {
    const error =
      read.reason === 'oversized' ? 'lens file exceeds the size cap' : 'failed to read lens file';
    logger.warn('Skipping unreadable lens file', { path: absPath, reason: read.reason });
    return { absPath, error, fileName, status: 'invalid', ...sourceRootField };
  }

  const parsed = parseLensFile(fileName, read.content);
  if (!parsed.ok) {
    logger.warn('Skipping invalid lens file', { error: parsed.error, path: absPath });
    return { absPath, error: parsed.error, fileName, status: 'invalid', ...sourceRootField };
  }

  return { absPath, fileName, lens: parsed.lens, status: 'ok', ...sourceRootField };
}

function ingestDirectory(
  baseDir: string,
  source: ScanSource,
  deps: UserLensScanDeps,
  seen: Map<string, LensIdOwner>,
  entries: UserLensScanEntry[],
  lenses: LensDefinition[],
  incompleteDirs: { dir: string; reason: 'cap-reached' | 'listing-truncated' }[]
): void {
  // The cap counts ENTRIES (valid + invalid), not accepted lenses — a
  // directory full of malformed files must consume the scan bound rather
  // than extend it, or `listLenses` over many roots becomes an unbounded
  // synchronous main-process scan (#2034 review, P2).
  const remaining = MAX_USER_LENSES_SCAN - entries.length;
  if (remaining <= 0) {
    warnCountCapReached();
    incompleteDirs.push({ dir: baseDir, reason: 'cap-reached' });
    return;
  }
  const listing = deps.listDir(baseDir, source.containmentRoot, LENS_DIR_LISTING_BOUND);
  if (!listing) {
    return;
  }
  if (listing.truncated) {
    logger.warn('Lens directory listing truncated; later files were not scanned', {
      bound: LENS_DIR_LISTING_BOUND,
      dir: baseDir,
    });
    incompleteDirs.push({ dir: baseDir, reason: 'listing-truncated' });
  }
  const fileNames = listing.entries
    .filter((entry) => entry.isFile && SQL_EXTENSION.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of fileNames) {
    if (entries.length >= MAX_USER_LENSES_SCAN) {
      warnCountCapReached();
      incompleteDirs.push({ dir: baseDir, reason: 'cap-reached' });
      return;
    }
    const entry = loadLensFile(fileName, baseDir, source, deps, seen);
    entries.push(entry);
    if (entry.status === 'ok') {
      lenses.push(entry.lens);
    }
  }
}

/**
 * Discover every lens across the two location tiers. Returns valid lenses
 * plus the full entry list (valid + invalid) in priority order.
 */
export function scanUserLenses(
  input: UserLensScanInput,
  deps: UserLensScanDeps
): UserLensScanResult {
  const seen = new Map<string, LensIdOwner>();
  const entries: UserLensScanEntry[] = [];
  const lenses: LensDefinition[] = [];
  const incompleteDirs: { dir: string; reason: 'cap-reached' | 'listing-truncated' }[] = [];

  // Tier 1: <root>/.brainstrike/lenses (mounted order).
  for (const root of input.roots) {
    ingestDirectory(
      joinPath(root.absPath, LENSES_SUBPATH),
      { containmentRoot: root.absPath, sourceRootId: root.id },
      deps,
      seen,
      entries,
      lenses,
      incompleteDirs
    );
  }
  // Tier 2: ~/.brainstrike/lenses.
  ingestDirectory(
    joinPath(input.homeDir, LENSES_SUBPATH),
    { containmentRoot: input.homeDir },
    deps,
    seen,
    entries,
    lenses,
    incompleteDirs
  );

  return { entries, incompleteDirs, lenses };
}
