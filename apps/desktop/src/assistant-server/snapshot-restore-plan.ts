/**
 * Pure restore-plan logic for the W7 shadow-git snapshot engine (BST-1164 T0).
 *
 * Everything in this module is git-free: parsers over `git diff --raw -z` /
 * `git ls-tree -r -z` stdout, the target→preRevert restore-plan computation,
 * and the empty-ancestor directory pruner. The git-spawning orchestration
 * lives in `snapshot-service.ts` / `snapshot-git.ts`; this module exists so
 * the destructive-seam logic is unit-testable without a repository.
 *
 * Mirrors `structured-diff-parsers.ts`'s posture: throw on unparseable or
 * unsupported input, never silently skip or coerce (NO SILENT FALLBACKS). An
 * unknown status letter or tree-entry mode is a thrown {@link RestorePlanError},
 * not a dropped record — a dropped record here would mean a path silently
 * excluded from a restore.
 *
 * The pruner is PORTED from the BST-1115 journal-revert pruner
 * (the retired journal revert executor's `pruneEmptyAncestorDirectories` on the W5
 * branch) — deliberately re-implemented rather than imported, because T4
 * retires that module. Semantics preserved exactly: walk UP from the deleted
 * file's parent, `rmdir` each now-empty directory, stop at the first refusal
 * (ENOTEMPTY = something this range did not create), and stop UNCONDITIONALLY
 * at the workspace root — the root is the boundary, never a candidate. The
 * refusal-stop is the documented termination condition, not a swallowed error:
 * the deletion the plan promised has already happened by the time the pruner
 * runs.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { isWithinRoot } from '@brainstrike/host-capabilities/native-tools';

/** Typed failure for plan parsing/computation — callers surface the message. */
export class RestorePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestorePlanError';
  }
}

/**
 * One record from `git diff --raw -z --no-abbrev --no-renames <from> [<to>]`.
 * `status` is intentionally NOT narrowed at parse time — the parser reports
 * git's letter verbatim and each consumer rejects the letters it cannot
 * handle, so an unexpected letter fails at the point that gives the clearest
 * error, never by silent omission.
 */
export interface RawDiffEntry {
  readonly newMode: string;
  readonly newOid: string;
  readonly oldMode: string;
  readonly oldOid: string;
  readonly path: string;
  readonly status: string;
}

// `:<oldmode> <newmode> <oldoid> <newoid> <status>` — oids are full hex
// (`--no-abbrev` is mandatory on the invocation), status is one letter with an
// optional similarity score (R/C only, which this engine never requests).
const RAW_HEADER_PATTERN = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])(\d+)?$/;

/**
 * Parse `git diff --raw -z --no-abbrev --no-renames` output. Records are
 * `header NUL path NUL` pairs; paths are verbatim (tabs/spaces preserved).
 * Rename/copy records (two-path triples) are rejected: every invocation in
 * this engine passes `--no-renames`, so their presence means the command was
 * built wrong — decoding them positionally here would be guess-work.
 */
export function parseRawDiffZ(stdout: string): readonly RawDiffEntry[] {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  const entries: RawDiffEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const header = fields[index] ?? '';
    const match = RAW_HEADER_PATTERN.exec(header);
    if (!match) {
      throw new RestorePlanError(`git diff --raw returned a malformed record "${header}"`);
    }
    const [, oldMode = '', newMode = '', oldOid = '', newOid = '', status = '', score] = match;
    if (score !== undefined || status === 'R' || status === 'C') {
      throw new RestorePlanError(
        `git diff --raw returned a rename/copy record "${header}" — the engine always diffs --no-renames`
      );
    }
    const entryPath = fields[index + 1];
    if (entryPath === undefined || entryPath.length === 0) {
      throw new RestorePlanError(`git diff --raw record "${header}" is missing its path field`);
    }
    entries.push({ newMode, newOid, oldMode, oldOid, path: entryPath, status });
    index += 2;
  }
  return entries;
}

/** One record from `git ls-tree -r -z <tree>`. */
export interface LsTreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
  readonly type: string;
}

// `<mode> <type> <oid>\t<path>` per NUL-terminated record.
const LS_TREE_PATTERN = /^(\d{6}) (\S+) ([0-9a-f]{40,64})\t([\s\S]+)$/;

/** Parse `git ls-tree -r -z` output (paths verbatim, NUL-terminated). */
export function parseLsTreeZ(stdout: string): readonly LsTreeEntry[] {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  return fields.map((record) => {
    const match = LS_TREE_PATTERN.exec(record);
    if (!match) {
      throw new RestorePlanError(`git ls-tree returned a malformed record "${record}"`);
    }
    const [, mode = '', type = '', oid = '', entryPath = ''] = match;
    return { mode, oid, path: entryPath, type };
  });
}

/**
 * One per-path action of a {@link RestorePlan}. Paths are always relative to
 * the workspace root (validated — never absolute, never escaping).
 *
 * - `restore-file` / `restore-symlink`: the path's content at the TARGET
 *   snapshot is written back (symlinks as symlinks, mode 120000).
 * - `delete-file`: the path was added between target and preRevert; restoring
 *   the target means deleting it (and pruning now-empty ancestor dirs,
 *   bounded at the root).
 * - `nested-repo`: a gitlink (mode 160000) on either side. Restoring or
 *   deleting a nested repository is out of scope by ruling (plan §Global 2);
 *   the action exists so apply reports a VISIBLE `skipped-nested-repo`
 *   outcome — never a silent skip, never an error.
 */
export type RestorePlanAction =
  | {
      readonly executable: boolean;
      readonly kind: 'restore-file';
      readonly path: string;
      readonly targetBlobOid: string;
    }
  | { readonly kind: 'restore-symlink'; readonly path: string; readonly targetBlobOid: string }
  | { readonly kind: 'delete-file'; readonly path: string }
  | { readonly kind: 'nested-repo'; readonly path: string };

/** Typed restore plan: what `applyRestorePlan` will do, and to which range. */
export interface RestorePlan {
  readonly actions: readonly RestorePlanAction[];
  readonly preRevertOid: string;
  readonly targetOid: string;
}

const GITLINK_MODE = '160000';
const SYMLINK_MODE = '120000';
const REGULAR_MODES = new Set(['100644', '100755']);

function assertContainedRelativePath(entryPath: string): void {
  if (entryPath.length === 0 || path.posix.isAbsolute(entryPath) || path.isAbsolute(entryPath)) {
    throw new RestorePlanError(`restore plan path "${entryPath}" must be root-relative`);
  }
  if (entryPath.split('/').includes('..')) {
    throw new RestorePlanError(`restore plan path "${entryPath}" escapes the workspace root`);
  }
}

function restoreActionForTargetSide(entry: RawDiffEntry): RestorePlanAction {
  // `M`/`T` entries with a gitlink on EITHER side, and `D` entries whose
  // target side is a gitlink, are nested-repo no-ops: content restore cannot
  // recreate a repository, and overwriting one would destroy it.
  if (entry.oldMode === GITLINK_MODE || entry.newMode === GITLINK_MODE) {
    return { kind: 'nested-repo', path: entry.path };
  }
  if (entry.oldMode === SYMLINK_MODE) {
    return { kind: 'restore-symlink', path: entry.path, targetBlobOid: entry.oldOid };
  }
  if (REGULAR_MODES.has(entry.oldMode)) {
    return {
      executable: entry.oldMode === '100755',
      kind: 'restore-file',
      path: entry.path,
      targetBlobOid: entry.oldOid,
    };
  }
  throw new RestorePlanError(
    `restore plan cannot handle target-side mode "${entry.oldMode}" for "${entry.path}"`
  );
}

/**
 * Compute the per-path actions restoring the TARGET snapshot from raw-diff
 * entries of `git diff --raw --no-renames <targetOid> <preRevertOid>`:
 *
 * - `A` (added between target and preRevert) → delete (or nested-repo for a
 *   gitlink — deleting one would `rm -rf` a repository).
 * - `M`/`T`/`D` (modified/typechanged/deleted in range) → restore the
 *   target-side content (file, symlink, or nested-repo no-op by mode).
 * - anything else → throw. `--no-renames` means `R`/`C` never appear; `U`
 *   cannot occur between two committed trees. An unknown letter is a bug in
 *   the invocation, and skipping it would silently exclude a path from the
 *   restore.
 *
 * Ordering: every restore precedes every delete, so ancestor-dir pruning
 * after deletes can never race a restore that needs the directory.
 */
export function computeRestorePlanActions(
  entries: readonly RawDiffEntry[]
): readonly RestorePlanAction[] {
  const restores: RestorePlanAction[] = [];
  const deletes: RestorePlanAction[] = [];
  for (const entry of entries) {
    assertContainedRelativePath(entry.path);
    if (entry.status === 'A') {
      if (entry.newMode === GITLINK_MODE) {
        deletes.push({ kind: 'nested-repo', path: entry.path });
      } else {
        deletes.push({ kind: 'delete-file', path: entry.path });
      }
      continue;
    }
    if (entry.status === 'M' || entry.status === 'T' || entry.status === 'D') {
      restores.push(restoreActionForTargetSide(entry));
      continue;
    }
    throw new RestorePlanError(
      `restore plan cannot handle diff status "${entry.status}" for "${entry.path}"`
    );
  }
  return [...restores, ...deletes];
}

/**
 * DIRECTORY PRUNE (ported from BST-1115; see the module doc comment).
 *
 * After deleting an added-in-range file, walk UP from its parent removing
 * each directory that is now EMPTY, stopping at the first directory `rmdir`
 * refuses (ENOTEMPTY or any other error) and unconditionally at the
 * workspace root. `isWithinRoot` is TRUE for the root itself, so the
 * `current !== canonicalRootPath` inequality — not the containment check —
 * is the boundary stop; a start directory outside the root never removes
 * anything.
 */
export async function pruneEmptyAncestorDirectories(
  canonicalRootPath: string,
  startDirectory: string
): Promise<void> {
  let current = startDirectory;
  while (current !== canonicalRootPath && isWithinRoot(canonicalRootPath, current)) {
    try {
      await fsPromises.rmdir(current);
    } catch {
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}
