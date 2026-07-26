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
import { MAX_USER_LENSES, parseLensFile, USER_LENS_DIRNAME } from '@brainstrike/assistant-contract';
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
);

export interface UserLensScanResult {
  /** Every discovered file in priority order (valid and invalid). */
  readonly entries: readonly UserLensScanEntry[];
  /** The valid lenses, in priority order. */
  readonly lenses: readonly LensDefinition[];
}

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
 */
function loadLensFile(
  fileName: string,
  baseDir: string,
  source: ScanSource,
  deps: UserLensScanDeps,
  seen: Map<string, string | undefined>
): UserLensScanEntry | null {
  const absPath = joinPath(baseDir, [fileName]);
  const sourceRootField = source.sourceRootId ? { sourceRootId: source.sourceRootId } : {};

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

  const id = parsed.lens.id;
  if (seen.has(id)) {
    warnCollision(id, source, seen.get(id));
    return null;
  }
  seen.set(id, source.sourceRootId);
  return { absPath, fileName, lens: parsed.lens, status: 'ok', ...sourceRootField };
}

function ingestDirectory(
  baseDir: string,
  source: ScanSource,
  deps: UserLensScanDeps,
  seen: Map<string, string | undefined>,
  entries: UserLensScanEntry[],
  lenses: LensDefinition[]
): void {
  const remaining = MAX_USER_LENSES_SCAN - lenses.length;
  if (remaining <= 0) {
    warnCountCapReached();
    return;
  }
  const listing = deps.listDir(baseDir, source.containmentRoot, remaining + 1);
  if (!listing) {
    return;
  }
  const fileNames = listing.entries
    .filter((entry) => entry.isFile && SQL_EXTENSION.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of fileNames) {
    if (lenses.length >= MAX_USER_LENSES_SCAN) {
      warnCountCapReached();
      return;
    }
    const entry = loadLensFile(fileName, baseDir, source, deps, seen);
    if (entry === null) {
      continue;
    }
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
  const seen = new Map<string, string | undefined>();
  const entries: UserLensScanEntry[] = [];
  const lenses: LensDefinition[] = [];

  // Tier 1: <root>/.brainstrike/lenses (mounted order).
  for (const root of input.roots) {
    ingestDirectory(
      joinPath(root.absPath, LENSES_SUBPATH),
      { containmentRoot: root.absPath, sourceRootId: root.id },
      deps,
      seen,
      entries,
      lenses
    );
  }
  // Tier 2: ~/.brainstrike/lenses.
  ingestDirectory(
    joinPath(input.homeDir, LENSES_SUBPATH),
    { containmentRoot: input.homeDir },
    deps,
    seen,
    entries,
    lenses
  );

  return { entries, lenses };
}
