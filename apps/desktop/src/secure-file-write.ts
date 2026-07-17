/**
 * The audited, symlink-safe, containment-checked WRITE path for main-process
 * file mutations. Extracted VERBATIM from `assistant-server/assistant-tools.ts`
 * so non-assistant IPC domains (e.g. the notes vault) can reuse the SINGLE
 * audited write path instead of forking a weaker copy. `assistant-tools.ts`
 * re-exports these symbols, so existing importers are unaffected.
 */

import { constants as fsConstants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { isWithinRoot, normalizeWorkspacePath } from './assistant-server/workspace-path';

/**
 * Find the canonical (symlink-resolved) path of the nearest existing ancestor of
 * `absolutePath`. The target file may not exist yet (the common write case), so
 * `fs.realpath` on it would throw ENOENT. We walk up until a directory exists,
 * `realpath` THAT, then re-append the not-yet-created tail. This canonicalizes
 * every existing symlink on the path so a symlinked parent that points outside
 * the root is still caught by the containment check below.
 */
async function resolveCanonicalWritablePath(absolutePath: string): Promise<string> {
  const segments: string[] = [];
  let current = absolutePath;
  // Walk up to the nearest existing ancestor. `path.dirname` is a fixpoint at the
  // filesystem root, so the loop always terminates.
  for (;;) {
    try {
      const canonicalExisting = await fsPromises.realpath(current);
      return segments.length > 0
        ? path.join(canonicalExisting, ...segments.reverse())
        : canonicalExisting;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor; return
        // the path unchanged (containment is still checked by the caller).
        return absolutePath;
      }
      segments.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a virtual workspace path to a containment-checked absolute path for a
 * WRITE, where the target file (and possibly some parent directories) may not yet
 * exist. Mirrors `resolveWorkspaceAbsolutePath`'s guarantees (see
 * `assistant-server/assistant-tools.ts`): ".." is clamped in
 * `normalizeWorkspacePath`, and the canonical existing-ancestor path is
 * containment-checked against the canonical root so a symlinked directory
 * cannot redirect the write outside the workspace.
 */
export async function resolveWorkspaceWritePath(
  rootPath: string,
  workspacePath: string
): Promise<{
  canonicalRootPath: string;
  workspacePath: string;
  absolutePath: string;
  requestedAbsolutePath: string;
}> {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  const relativePath =
    normalizedWorkspacePath === '/' ? '' : normalizedWorkspacePath.replace(/^\/+/, '');
  if (relativePath.length === 0) {
    throw new Error(`Path "${workspacePath}" is the workspace root, not a writable file.`);
  }
  const absolutePath = path.resolve(rootPath, relativePath);
  const canonicalRootPath = await fsPromises.realpath(rootPath);
  const canonicalAbsolutePath = await resolveCanonicalWritablePath(absolutePath);
  if (!isWithinRoot(canonicalRootPath, canonicalAbsolutePath)) {
    throw new Error(`Path "${workspacePath}" is outside the selected workspace root.`);
  }
  return {
    // Canonical (symlink-resolved) target — correct for WRITE tools, which write
    // THROUGH a symlink to its target. `requestedAbsolutePath` is the raw
    // (pre-realpath) requested path — delete/rename need it to act on the LINK
    // itself rather than the resolved target (see resolveWorkspaceLeafMutationPath).
    absolutePath: canonicalAbsolutePath,
    canonicalRootPath,
    requestedAbsolutePath: absolutePath,
    workspacePath: normalizedWorkspacePath,
  };
}

/**
 * Create every missing directory between `canonicalRootPath` (which must already
 * exist) and `targetDir`, ONE component at a time, rejecting any existing
 * component that is a symlink. A plain `mkdir -p` would happily traverse a
 * symlinked intermediate directory (including a dangling one, by creating its
 * target), which is a containment-escape vector. Walking component-by-component
 * with an `lstat` guard keeps every created/traversed segment a real directory
 * inside the root.
 */
export async function ensureContainedDirectory(
  canonicalRootPath: string,
  targetDir: string
): Promise<void> {
  if (targetDir === canonicalRootPath) {
    return;
  }
  const relative = path.relative(canonicalRootPath, targetDir);
  // Defence in depth: resolveWorkspaceWritePath already guarantees containment.
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${targetDir}" is outside the selected workspace root.`);
  }
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  let current = canonicalRootPath;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats: import('node:fs').Stats | undefined;
    try {
      stats = await fsPromises.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (stats) {
      // An existing component that is a symlink (live OR dangling) could redirect
      // the write outside the root — reject it rather than traverse it.
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Path component "${current}" is a symlink, which is outside the selected workspace root.`
        );
      }
      if (!stats.isDirectory()) {
        throw new Error(`Path component "${current}" is not a directory.`);
      }
      continue;
    }
    // Component does not exist: mkdir creates a REAL directory (it never follows
    // into a symlink it did not create).
    await fsPromises.mkdir(current);
  }
}

/**
 * Symlink-safe, containment-checked write of `buffer` to the already-resolved
 * workspace write path. This is the SINGLE audited write path shared by
 * `writeWorkspaceFile` and `stringReplaceWorkspaceFile` — do not fork a weaker
 * copy. It enforces every PR-2.1 guarantee:
 *  - leaf lstat rejects a symlink leaf (live OR dangling) and a directory target,
 *  - parents are created one component at a time, rejecting symlinked intermediates,
 *  - the final open uses O_NOFOLLOW to close the lstat→open TOCTOU window.
 *
 * Caller must have resolved the path through {@link resolveWorkspaceWritePath}
 * (so ".." is clamped and the canonical existing-ancestor is contained) and must
 * pass `requestedPath` only for error messages. Returns whether the file was
 * newly created.
 */
export async function writeContainedFileBytes(args: {
  resolved: { absolutePath: string; canonicalRootPath: string };
  buffer: Buffer;
  requestedPath: string;
  /**
   * Refuse (instead of recreating) a missing parent directory. Overwrite-style
   * writers (notes-vault autosave) must set this: their parent vanishing means
   * the entry was renamed or deleted concurrently, and recreating it would
   * silently resurrect the old directory with stale content.
   */
  requireParentDirectory?: boolean;
}): Promise<{ created: boolean }> {
  const { resolved, buffer, requestedPath, requireParentDirectory } = args;

  if (requireParentDirectory) {
    try {
      await fsPromises.lstat(path.dirname(resolved.absolutePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      throw new Error(
        `Parent directory of "${requestedPath}" no longer exists; it may have been renamed or deleted.`
      );
    }
  }

  // Inspect the leaf WITHOUT following symlinks. A symlink leaf (live OR
  // dangling) passes the canonical-ancestor containment check yet writeFile would
  // follow it OUTSIDE the root — reject it as a containment escape. lstat also
  // distinguishes a directory target, which cannot be overwritten with content.
  let created = true;
  try {
    const leafStats = await fsPromises.lstat(resolved.absolutePath);
    if (leafStats.isSymbolicLink()) {
      throw new Error(`Path "${requestedPath}" is outside the selected workspace root.`);
    }
    if (leafStats.isDirectory()) {
      throw new Error(
        `Path "${requestedPath}" is a directory and cannot be overwritten with a file.`
      );
    }
    created = false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  // Create missing parents one component at a time, rejecting symlinked
  // intermediates (a plain mkdir -p would traverse them).
  await ensureContainedDirectory(resolved.canonicalRootPath, path.dirname(resolved.absolutePath));

  // O_NOFOLLOW closes the lstat→open TOCTOU window: if the leaf is (or becomes) a
  // symlink, the open syscall itself fails with ELOOP rather than following it.
  // (Falls back to 0 on platforms without O_NOFOLLOW, e.g. Windows; the lstat
  // guard above is the portable backstop.)
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const writeFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow;
  const fileHandle = await fsPromises.open(resolved.absolutePath, writeFlags);
  try {
    await fileHandle.writeFile(buffer);
  } finally {
    await fileHandle.close();
  }
  return { created };
}
